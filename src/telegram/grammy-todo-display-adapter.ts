// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.
import { readTodoFile, type TodoDisplayPort, type TodoStore, type TodoUpdatePayload } from "../agent/mod.ts";
import { logDebug } from "../shared/mod.ts";
import { formatTodoListMarkdown, formatTodoListPlain } from "./todo-list-format.ts";

type TodoEditMessageOptions = { parse_mode?: "MarkdownV2"; message_thread_id?: number };

/**
 * Minimal Telegram context for todo status messages.
 * @internal
 */
export interface TodoDisplayContext {
  reply(
    text: string,
    options?: { parse_mode?: "MarkdownV2"; message_thread_id?: number },
  ): Promise<{ message_id: number }>;
  api: {
    editMessageText(
      chatId: number,
      messageId: number,
      text: string,
      options?: TodoEditMessageOptions,
    ): Promise<unknown>;
  };
  chat?: { id?: number };
  message?: { message_thread_id?: number };
}

function isTelegramBadRequest(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "error_code" in error && error.error_code === 400,
  );
}

function isTodoDisplayContext(ctx: unknown): ctx is TodoDisplayContext {
  return typeof ctx === "object" && ctx !== null && "reply" in ctx && "api" in ctx;
}

type StoredTelegramMeta = { chatId: number; threadId?: number; messageId: number };

async function sendOrEditTodoMessage(
  ctx: TodoDisplayContext,
  textMarkdown: string,
  textPlain: string,
  telegram: StoredTelegramMeta | undefined,
  messageThreadId?: number,
): Promise<StoredTelegramMeta> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) throw new Error("No chat id in context");

  if (telegram?.messageId) {
    try {
      await ctx.api.editMessageText(
        chatId,
        telegram.messageId,
        textMarkdown,
        {
          parse_mode: "MarkdownV2",
          message_thread_id: messageThreadId,
        },
      );
      return {
        chatId: telegram.chatId,
        threadId: telegram.threadId,
        messageId: telegram.messageId,
      };
    } catch (error) {
      if (isTelegramBadRequest(error)) {
        try {
          await ctx.api.editMessageText(
            chatId,
            telegram.messageId,
            textPlain,
            {
              message_thread_id: messageThreadId,
            },
          );
          return {
            chatId: telegram.chatId,
            threadId: telegram.threadId,
            messageId: telegram.messageId,
          };
        } catch {
          logDebug("todo_display.edit_failed", { messageId: telegram.messageId });
        }
      } else {
        logDebug("todo_display.edit_failed", { message: String(error) });
      }
    }
  }

  try {
    const sent = await ctx.reply(textMarkdown, {
      parse_mode: "MarkdownV2",
      message_thread_id: messageThreadId,
    });
    return { chatId, threadId: messageThreadId, messageId: sent.message_id };
  } catch (error) {
    if (!isTelegramBadRequest(error)) throw error;
    const sent = await ctx.reply(textPlain, { message_thread_id: messageThreadId });
    return { chatId, threadId: messageThreadId, messageId: sent.message_id };
  }
}

/** Shows or updates the todo status message for a session (used by /todo and /todos). @internal */
export async function showTodosForSession(
  ctx: TodoDisplayContext,
  sessionId: string,
  store: TodoStore,
): Promise<void> {
  const file = await readTodoFile(store, sessionId);
  const markdown = formatTodoListMarkdown(file.todos);
  const plain = formatTodoListPlain(file.todos);
  const threadId = ctx.message?.message_thread_id;
  const meta = await sendOrEditTodoMessage(ctx, markdown, plain, file.telegram, threadId);
  await store.updateTelegramMeta(sessionId, meta);
}

/** Telegram port for edit-in-place todo display during model.act(). @internal */
export function createTelegramTodoDisplayPort(deps: {
  store: TodoStore;
}): TodoDisplayPort {
  let turn: { ctx: TodoDisplayContext; signal: AbortSignal } | undefined;
  const editChains = new Map<string, Promise<void>>();

  const port: TodoDisplayPort = {
    isAvailable: () => true,
    setTurnContext(target: { ctx: unknown; signal: AbortSignal }): void {
      if (!isTodoDisplayContext(target.ctx)) {
        throw new Error("Todo display requires a Telegram context");
      }
      turn = { ctx: target.ctx, signal: target.signal };
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    async onTodosUpdated(payload: TodoUpdatePayload): Promise<void> {
      if (!turn || turn.signal.aborted) return;

      const { ctx, signal } = turn;
      const threadId = ctx.message?.message_thread_id;
      const markdown = formatTodoListMarkdown(payload.todos);
      const plain = formatTodoListPlain(payload.todos);

      const run = async (): Promise<void> => {
        if (signal.aborted) return;
        const meta = await sendOrEditTodoMessage(ctx, markdown, plain, payload.telegram, threadId);
        if (signal.aborted) return;
        await deps.store.updateTelegramMeta(payload.sessionId, meta);
      };

      const previous = editChains.get(payload.sessionId) ?? Promise.resolve();
      const next = previous.then(run, run);
      editChains.set(payload.sessionId, next);
      await next;
      if (editChains.get(payload.sessionId) === next) {
        editChains.delete(payload.sessionId);
      }
    },
  };

  return port;
}
