import type { Tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { errorMessage } from "../../shared/error.ts";
import { logDebug } from "../../shared/log.ts";
import { requestForOperation } from "./approval-support.ts";
import type { ToolContext } from "./context.ts";
import {
  type AgentToolCapabilityRequestSpec,
  type AgentToolDefinition,
  type AgentToolDeps,
  toolFromDefinition,
} from "./definitions.ts";
import type { TodoDisplayPort } from "./todo-display-port.ts";
import type { TodoChanges, TodoItem, TodoStore, TodoTelegramMeta } from "./todo-store.ts";

export { DenoKvTodoStore, detectTodoChanges } from "./todo-store.ts";
export type { TodoChanges, TodoFile, TodoItem, TodoStatus, TodoStore, TodoTelegramMeta } from "./todo-store.ts";

/** Parameters for the todo_write tool. */
export interface TodoWriteParams {
  todos: TodoItem[];
}

/** Dependencies for the todo_write tool. */
export interface TodoWriteDeps {
  getSessionId: () => string;
  store: TodoStore;
  workspace?: ToolContext;
  display?: TodoDisplayPort;
}

const persistedTodoItemSchema = z.object({
  id: z.string().trim().min(1),
  content: z.string().trim().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
});

const todoWriteParamsSchema = z.object({
  todos: z.array(persistedTodoItemSchema),
}).superRefine((params, ctx) => {
  const ids = params.todos.map((todo) => todo.id);
  if (ids.length !== new Set(ids).size) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Todo IDs must be unique within the array.",
      path: ["todos"],
    });
  }
});

/**
 * Validates todo_write params (Qwen-aligned rules).
 * @returns Error message or null if valid.
 */
export function validateTodoWriteParams(params: TodoWriteParams): string | null {
  if (!params || typeof params !== "object" || !Array.isArray(params.todos)) {
    return 'Parameter "todos" must be an array.';
  }
  const result = todoWriteParamsSchema.safeParse(params);
  if (result.success) return null;
  for (const issue of result.error.issues) {
    if (issue.message === "Todo IDs must be unique within the array.") return issue.message;
    if (issue.path.at(-1) === "id") return 'Each todo must have a non-empty "id" string.';
    if (issue.path.at(-1) === "content") return 'Each todo must have a non-empty "content" string.';
    if (issue.path.at(-1) === "status") {
      return 'Each todo must have a valid "status" (pending, in_progress, completed).';
    }
  }
  return result.error.issues[0]?.message ?? "Invalid todo_write params.";
}

/** Formats the LLM-facing tool result with system-reminder blocks (Qwen-aligned). */
export function formatTodoWriteResult(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return `Todo list has been cleared.

<system-reminder>
Your todo list is now empty. DO NOT mention this explicitly to the user. You have no pending tasks in your todo list.
</system-reminder>`;
  }

  const todosJson = JSON.stringify(todos);
  return `Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable

<system-reminder>
Your todo list has changed. DO NOT mention this explicitly to the user. Here are the latest contents of your todo list:

${todosJson}. Continue on with the tasks at hand if applicable.
</system-reminder>`;
}

const TODO_WRITE_DESCRIPTION =
  `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Only have ONE task in_progress at any time
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if tests are failing, implementation is partial, or you encountered unresolved errors

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.`;

const todoItemSchema = z.object({
  id: z.string().min(1).describe("Unique task identifier."),
  content: z.string().min(1).describe("Task description."),
  status: z.enum(["pending", "in_progress", "completed"]).describe("Task status."),
});

const todoWriteParameters = {
  todos: z.array(todoItemSchema).describe("The updated todo list."),
} as const;

export const todoWriteToolDefinition: AgentToolDefinition<typeof todoWriteParameters> = {
  name: "todo_write",
  description: TODO_WRITE_DESCRIPTION,
  parameters: todoWriteParameters,
  authorize: ({ todos }, deps): AgentToolCapabilityRequestSpec => {
    const sessionId = deps.todos.getSessionId();
    return requestForOperation(deps.workspace, {
      operation: "todo",
      target: deps.todos.store.label(sessionId),
      risk: "medium",
      summary: `write ${todos.length} todo item(s)`,
    });
  },
  run: (params, deps): Promise<string> => {
    return runTodoWrite(params, deps.todos);
  },
};

async function runTodoWrite(params: TodoWriteParams, deps: TodoWriteDeps): Promise<string> {
  const validationError = validateTodoWriteParams(params);
  if (validationError) {
    return validationError;
  }

  const sessionId = deps.getSessionId();
  let updateResult: { changes: TodoChanges; telegram?: TodoTelegramMeta };

  try {
    updateResult = await deps.store.updateTodos(sessionId, params.todos);
  } catch (error) {
    const message = errorMessage(error);
    logDebug("todo_write.persist_error", { sessionId, message });
    return `Failed to modify todos. An error occurred during the operation.

<system-reminder>
Todo list modification failed with error: ${message}. You may need to retry or handle this error appropriately.
</system-reminder>`;
  }

  if (deps.display?.isAvailable()) {
    try {
      await deps.display.onTodosUpdated({
        sessionId,
        todos: params.todos,
        changes: updateResult.changes,
        telegram: updateResult.telegram,
      });
    } catch (error) {
      const message = errorMessage(error);
      logDebug("todo_write.display_error", { sessionId, message });
    }
  }

  return formatTodoWriteResult(params.todos);
}

/** LM Studio tool that persists session-scoped todos and optionally updates Telegram display. */
export function createTodoWriteTool(deps: TodoWriteDeps): Tool {
  return toolFromDefinition(todoWriteToolDefinition, { todos: deps } as AgentToolDeps);
}
