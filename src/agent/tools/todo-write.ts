import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { logDebug } from "../../shared/log.ts";
import type { ToolContext } from "./context.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import type { TodoDisplayPort } from "./todo-display-port.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

/** One task in the session todo list. */
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** Telegram message reference for edit-in-place todo display. */
export interface TodoTelegramMeta {
  chatId: number;
  threadId?: number;
  messageId: number;
}

/** Changes detected when comparing old and new todo lists. */
export interface TodoChanges {
  created: TodoItem[];
  completed: TodoItem[];
}

/** On-disk todo file shape. */
export interface TodoFile {
  sessionId: string;
  todos: TodoItem[];
  telegram?: TodoTelegramMeta;
}

/** Parameters for the todo_write tool. */
export interface TodoWriteParams {
  todos: TodoItem[];
}

/** Dependencies for the todo_write tool. */
export interface TodoWriteDeps {
  getSessionId: () => string;
  todosDir: string;
  workspace?: ToolContext;
  display?: TodoDisplayPort;
  updateTelegramMeta?: (sessionId: string, meta: TodoTelegramMeta) => Promise<void>;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

const todoTelegramMetaSchema = z.object({
  chatId: z.number(),
  threadId: z.number().optional(),
  messageId: z.number(),
});

const todoFileSchema = z.object({
  sessionId: z.string().regex(SESSION_ID_PATTERN),
  todos: z.array(persistedTodoItemSchema),
  telegram: todoTelegramMetaSchema.optional(),
});

function assertValidSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error("Invalid session id");
}

function todoFilePath(todosDir: string, sessionId: string): string {
  assertValidSessionId(sessionId);
  return `${todosDir}/${sessionId}.json`;
}

/** Compare old and new todo lists to detect created and completed items. */
export function detectTodoChanges(oldTodos: TodoItem[], newTodos: TodoItem[]): TodoChanges {
  const oldTodosMap = new Map(oldTodos.map((t) => [t.id, t]));
  const changes: TodoChanges = { created: [], completed: [] };

  for (const newTodo of newTodos) {
    const oldTodo = oldTodosMap.get(newTodo.id);
    if (!oldTodo) {
      changes.created.push(newTodo);
    } else if (oldTodo.status !== "completed" && newTodo.status === "completed") {
      changes.completed.push(newTodo);
    }
  }

  return changes;
}

/**
 * Validates todo_write params (Qwen-aligned rules).
 * @returns Error message or null if valid.
 */
export function validateTodoWriteParams(params: TodoWriteParams): string | null {
  if (!params || typeof params !== "object") {
    return 'Parameter "todos" must be an array.';
  }
  if (!Array.isArray(params.todos)) {
    return 'Parameter "todos" must be an array.';
  }

  for (const todo of params.todos as unknown[]) {
    const record = todo as Partial<TodoItem>;
    if (!record.id || typeof record.id !== "string" || record.id.trim() === "") {
      return 'Each todo must have a non-empty "id" string.';
    }
    if (!record.content || typeof record.content !== "string" || record.content.trim() === "") {
      return 'Each todo must have a non-empty "content" string.';
    }
    if (!persistedTodoItemSchema.shape.status.safeParse(record.status).success) {
      return 'Each todo must have a valid "status" (pending, in_progress, completed).';
    }
  }

  const result = todoWriteParamsSchema.safeParse(params);
  if (
    !result.success &&
    result.error.issues.some((issue) => issue.message === "Todo IDs must be unique within the array.")
  ) {
    return "Todo IDs must be unique within the array.";
  }

  return null;
}

async function readTodoFileRaw(todosDir: string, sessionId: string): Promise<TodoFile> {
  const path = todoFilePath(todosDir, sessionId);
  try {
    const content = await Deno.readTextFile(path);
    const parsed = todoFileSchema.parse(JSON.parse(content));
    return {
      sessionId,
      todos: parsed.todos,
      telegram: parsed.telegram,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { sessionId, todos: [] };
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new Error(`Invalid todo file for session ${sessionId}: ${error.message}`);
    }
    throw error;
  }
}

/** Reads the todo file for a session. */
export function readTodoFile(todosDir: string, sessionId: string): Promise<TodoFile> {
  return withFileMutationQueue(todoFilePath(todosDir, sessionId), () => readTodoFileRaw(todosDir, sessionId));
}

async function writeTodoFileRaw(todosDir: string, file: TodoFile): Promise<void> {
  const path = todoFilePath(todosDir, file.sessionId);
  await Deno.mkdir(todosDir, { recursive: true });
  const tempPath = `${path}.tmp`;
  await Deno.writeTextFile(tempPath, JSON.stringify(file, null, 2));
  await Deno.rename(tempPath, path);
}

async function updateTodoFileRaw<T>(
  todosDir: string,
  sessionId: string,
  update: (existing: TodoFile) => { file: TodoFile; result: T } | Promise<{ file: TodoFile; result: T }>,
): Promise<T> {
  return await withFileMutationQueue(todoFilePath(todosDir, sessionId), async () => {
    const existing = await readTodoFileRaw(todosDir, sessionId);
    const { file, result } = await update(existing);
    await writeTodoFileRaw(todosDir, {
      sessionId,
      todos: file.todos,
      telegram: file.telegram,
    });
    return result;
  });
}

/** Writes todos to disk, preserving optional telegram metadata when omitted. */
export function writeTodoFile(todosDir: string, file: TodoFile): Promise<void> {
  return updateTodoFileRaw(todosDir, file.sessionId, (existing) => ({
    file: {
      sessionId: file.sessionId,
      todos: file.todos,
      telegram: file.telegram ?? existing.telegram,
    },
    result: undefined,
  }));
}

/** Merges telegram metadata into the session todo file without changing todos. */
export function updateTelegramMeta(
  todosDir: string,
  sessionId: string,
  meta: TodoTelegramMeta,
): Promise<void> {
  return updateTodoFileRaw(todosDir, sessionId, (existing) => ({
    file: {
      ...existing,
      sessionId,
      telegram: meta,
    },
    result: undefined,
  }));
}

/** Returns todos for a session (empty array if no file). */
export async function readTodosForSession(todosDir: string, sessionId: string): Promise<TodoItem[]> {
  const file = await readTodoFile(todosDir, sessionId);
  return file.todos;
}

/** Copies a todo file from one session id to another (for /fork). */
export async function copyTodosForSession(
  todosDir: string,
  fromId: string,
  toId: string,
): Promise<void> {
  assertValidSessionId(fromId);
  assertValidSessionId(toId);
  const fromPath = todoFilePath(todosDir, fromId);
  let source: TodoFile;
  try {
    await withFileMutationQueue(fromPath, async () => {
      source = await readTodoFileRaw(todosDir, fromId);
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  await updateTodoFileRaw(todosDir, toId, () => ({
    file: {
      sessionId: toId,
      todos: source.todos,
      telegram: undefined,
    },
    result: undefined,
  }));
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

/** LM Studio tool that persists session-scoped todos and optionally updates Telegram display. */
export function createTodoWriteTool(deps: TodoWriteDeps): Tool {
  return tool({
    name: "todo_write",
    description: TODO_WRITE_DESCRIPTION,
    parameters: {
      todos: z.array(todoItemSchema).describe("The updated todo list."),
    },
    implementation: async (params) => {
      const validationError = validateTodoWriteParams(params);
      if (validationError) {
        return validationError;
      }

      const sessionId = deps.getSessionId();
      let updateResult: { changes: TodoChanges; telegram?: TodoTelegramMeta };

      try {
        updateResult = await updateTodoFileRaw(deps.todosDir, sessionId, (existingFile) => {
          const changes = detectTodoChanges(existingFile.todos, params.todos);
          return {
            file: {
              sessionId,
              todos: params.todos,
              telegram: existingFile.telegram,
            },
            result: {
              changes,
              telegram: existingFile.telegram,
            },
          };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
          const message = error instanceof Error ? error.message : String(error);
          logDebug("todo_write.display_error", { sessionId, message });
        }
      }

      return formatTodoWriteResult(params.todos);
    },
  });
}
