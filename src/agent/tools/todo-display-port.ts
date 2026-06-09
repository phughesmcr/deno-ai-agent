import type { TodoChanges, TodoItem, TodoTelegramMeta } from "./todo-store.ts";

/**
 * Payload passed to the display port after todos are persisted.
 * @internal
 */
export interface TodoUpdatePayload {
  sessionId: string;
  todos: TodoItem[];
  changes: TodoChanges;
  telegram?: TodoTelegramMeta;
}

/**
 * Optional Telegram display for todo list updates during model turns.
 * @internal
 */
export interface TodoDisplayPort {
  isAvailable(): boolean;
  setTurnContext(target: { ctx: unknown; signal: AbortSignal }): void;
  clearTurnContext(): void;
  onTodosUpdated(payload: TodoUpdatePayload): Promise<void>;
}

/**
 * Port for tests and non-Telegram tool registration.
 * @internal
 */
export function createNoopTodoDisplayPort(): TodoDisplayPort {
  return {
    isAvailable: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    onTodosUpdated: () => Promise.resolve(),
  };
}
