import type { Tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { errorMessage } from "../../shared/error.ts";
import { logDebug } from "../../shared/log.ts";
import { requestForOperation, todoKvDisplayPath } from "./approval-support.ts";
import type { ToolContext } from "./context.ts";
import {
  type AgentToolCapabilityRequestSpec,
  type AgentToolDefinition,
  type AgentToolDeps,
  toolFromDefinition,
} from "./definitions.ts";
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

/** Persisted todo state shape. */
export interface TodoFile {
  sessionId: string;
  todos: TodoItem[];
  telegram?: TodoTelegramMeta;
}

/** Session-scoped todo persistence boundary. */
export interface TodoStore {
  read(sessionId: string): Promise<TodoFile>;
  write(file: TodoFile): Promise<void>;
  updateTodos(sessionId: string, todos: TodoItem[]): Promise<{ changes: TodoChanges; telegram?: TodoTelegramMeta }>;
  updateTelegramMeta(sessionId: string, meta: TodoTelegramMeta): Promise<void>;
  copy(fromId: string, toId: string): Promise<void>;
  label(sessionId: string): string;
}

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

function todoKey(sessionId: string): Deno.KvKey {
  assertValidSessionId(sessionId);
  return ["todos", sessionId];
}

function parseTodoFile(value: unknown, sessionId: string): TodoFile {
  try {
    const parsed = todoFileSchema.parse(value);
    if (parsed.sessionId !== sessionId) {
      throw new Error(`Todo state id mismatch: expected ${sessionId}, got ${parsed.sessionId}`);
    }
    return {
      sessionId,
      todos: parsed.todos,
      telegram: parsed.telegram,
    };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof Error) {
      throw new Error(`Invalid todo state for session ${sessionId}: ${error.message}`);
    }
    throw error;
  }
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

/** Deno KV-backed todo persistence for one workspace. */
export class DenoKvTodoStore implements TodoStore {
  private readonly _kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  async read(sessionId: string): Promise<TodoFile> {
    const entry = await this._kv.get<unknown>(todoKey(sessionId));
    if (entry.value === null) return { sessionId, todos: [] };
    return parseTodoFile(entry.value, sessionId);
  }

  async write(file: TodoFile): Promise<void> {
    assertValidSessionId(file.sessionId);
    await this._update(file.sessionId, (existing) => ({
      file: {
        sessionId: file.sessionId,
        todos: file.todos,
        telegram: file.telegram ?? existing.telegram,
      },
      result: undefined,
    }));
  }

  async updateTodos(
    sessionId: string,
    todos: TodoItem[],
  ): Promise<{ changes: TodoChanges; telegram?: TodoTelegramMeta }> {
    return await this._update(sessionId, (existing) => {
      const changes = detectTodoChanges(existing.todos, todos);
      return {
        file: {
          sessionId,
          todos,
          telegram: existing.telegram,
        },
        result: {
          changes,
          telegram: existing.telegram,
        },
      };
    });
  }

  async updateTelegramMeta(sessionId: string, meta: TodoTelegramMeta): Promise<void> {
    await this._update(sessionId, (existing) => ({
      file: {
        ...existing,
        sessionId,
        telegram: meta,
      },
      result: undefined,
    }));
  }

  async copy(fromId: string, toId: string): Promise<void> {
    assertValidSessionId(fromId);
    assertValidSessionId(toId);
    const sourceEntry = await this._kv.get<unknown>(todoKey(fromId));
    if (sourceEntry.value === null) return;
    const source = parseTodoFile(sourceEntry.value, fromId);
    await this._update(toId, () => ({
      file: {
        sessionId: toId,
        todos: source.todos,
        telegram: undefined,
      },
      result: undefined,
    }));
  }

  label(sessionId: string): string {
    assertValidSessionId(sessionId);
    return todoKvDisplayPath(sessionId);
  }

  private async _update<T>(
    sessionId: string,
    update: (existing: TodoFile) => { file: TodoFile; result: T } | Promise<{ file: TodoFile; result: T }>,
  ): Promise<T> {
    const key = todoKey(sessionId);
    while (true) {
      const entry = await this._kv.get<unknown>(key);
      const existing = entry.value === null ? { sessionId, todos: [] } : parseTodoFile(entry.value, sessionId);
      const { file, result } = await update(existing);
      const next: TodoFile = {
        sessionId,
        todos: file.todos,
        telegram: file.telegram,
      };
      const commit = await this._kv.atomic().check(entry).set(key, next).commit();
      if (commit.ok) return result;
    }
  }
}

/** Reads the todo state for a session. */
export function readTodoFile(store: TodoStore, sessionId: string): Promise<TodoFile> {
  return store.read(sessionId);
}

/** Writes todos, preserving optional telegram metadata when omitted. */
export function writeTodoFile(store: TodoStore, file: TodoFile): Promise<void> {
  return store.write(file);
}

/** Merges telegram metadata into the session todo state without changing todos. */
export function updateTelegramMeta(
  store: TodoStore,
  sessionId: string,
  meta: TodoTelegramMeta,
): Promise<void> {
  return store.updateTelegramMeta(sessionId, meta);
}

/** Returns todos for a session (empty array if no state). */
export async function readTodosForSession(store: TodoStore, sessionId: string): Promise<TodoItem[]> {
  const file = await store.read(sessionId);
  return file.todos;
}

/** Copies todo state from one session id to another (for /fork). */
export function copyTodosForSession(
  store: TodoStore,
  fromId: string,
  toId: string,
): Promise<void> {
  return store.copy(fromId, toId);
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
