import { z } from "zod/v3";

import { todoKvDisplayPath } from "./approval-support.ts";

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

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const persistedTodoItemSchema = z.object({
  id: z.string().trim().min(1),
  content: z.string().trim().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
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
