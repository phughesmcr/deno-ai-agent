import type { Context } from "grammy";
import { readTodoFile, type TodoDisplayPort, type TodoUpdatePayload } from "../agent/mod.ts";
import { logDebug } from "../shared/mod.ts";
import { formatTodoListMarkdown, formatTodoListPlain } from "./todo-list-format.ts";
import type { TelegramContext } from "./telegram.ts";

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
      options?: unknown,
    ): Promise<unknown>;
  };
  chat?: { id?: number };
  // deno-lint-ignore camelcase -- Telegram API field name
  message?: { message_thread_id?: number };
}

function isTelegramBadRequest(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "error_code" in error && error.error_code === 400,
  );
}

type ReplyContext = TodoDisplayContext;

type StoredTelegramMeta = { chatId: number; threadId?: number; messageId: number };

async function sendOrEditTodoMessage(
  ctx: ReplyContext,
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
        } as Parameters<Context["api"]["editMessageText"]>[3],
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
            } as Parameters<Context["api"]["editMessageText"]>[3],
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

/** Shows or updates the todo status message for a session (used by /todos command). @internal */
export async function showTodosForSession(
  ctx: TodoDisplayContext,
  sessionId: string,
  todosDir: string,
  onUpdateMeta: (sessionId: string, meta: { chatId: number; threadId?: number; messageId: number }) => Promise<void>,
): Promise<void> {
  const file = await readTodoFile(todosDir, sessionId);
  const markdown = formatTodoListMarkdown(file.todos);
  const plain = formatTodoListPlain(file.todos);
  const threadId = ctx.message?.message_thread_id;
  const meta = await sendOrEditTodoMessage(ctx, markdown, plain, file.telegram, threadId);
  await onUpdateMeta(sessionId, meta);
}

/** Telegram port for edit-in-place todo display during model.act(). @internal */
export function createTelegramTodoDisplayPort(deps: {
  updateTelegramMeta: (
    sessionId: string,
    meta: { chatId: number; threadId?: number; messageId: number },
  ) => Promise<void>;
}): TodoDisplayPort {
  let turn: { ctx: TelegramContext; signal: AbortSignal } | undefined;
  const editChains = new Map<string, Promise<void>>();

  const port: TodoDisplayPort = {
    isAvailable: () => true,
    setTurnContext(target: { ctx: unknown; signal: AbortSignal }): void {
      turn = target as { ctx: TelegramContext; signal: AbortSignal };
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
        await deps.updateTelegramMeta(payload.sessionId, meta);
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
