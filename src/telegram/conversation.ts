// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

/** Telegram chat plus optional forum topic thread. */
export interface TelegramConversationRef {
  /** Telegram chat id. */
  chatId: number;
  /** Telegram forum topic message thread id, absent for private chats, groups, and the main chat. */
  threadId?: number;
}

interface TelegramConversationContext {
  chat?: { id?: number };
  message?: { message_thread_id?: number };
  callbackQuery?: {
    message?: {
      message_thread_id?: number;
      chat?: { id?: number };
    };
  };
}

/** Stable key segment for a Telegram thread inside one chat. */
export function telegramThreadKey(threadId: number | undefined): string {
  return threadId === undefined ? "main" : `thread:${threadId}`;
}

/** Human-readable conversation key used for queues and diagnostics. */
export function telegramConversationKey(ref: TelegramConversationRef): string {
  return `${ref.chatId}:${telegramThreadKey(ref.threadId)}`;
}

/**
 * Derives the Telegram conversation ref from a Grammy-like context.
 * @internal
 */
export function telegramConversationRef(ctx: TelegramConversationContext): TelegramConversationRef | undefined {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;
  if (chatId === undefined) return undefined;
  const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id;
  return threadId === undefined ? { chatId } : { chatId, threadId };
}
