// deno-lint-ignore-file camelcase -- Telegram API uses snake_case keys
import { plainReply, stripThinking } from "../markdown.ts";

/** Telegram reply target parameters. */
export interface TelegramReplyParameters {
  /** Message id to reply to. */
  message_id: number;
}

/** Minimal Telegram reply options used by model replies. */
export interface TelegramReplyOptions {
  /** Telegram parse mode. */
  parse_mode?: "MarkdownV2";
  /** Message reply target. */
  reply_parameters?: TelegramReplyParameters;
  /** Forum topic thread id. */
  message_thread_id?: number;
}

/** Minimal reply sender surface shared by Grammy contexts and tests. */
export interface TelegramReplySender {
  /** Sends a Telegram message. */
  reply(text: string, options?: TelegramReplyOptions): Promise<unknown>;
}

function isTelegramBadRequest(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "error_code" in error && error.error_code === 400,
  );
}

/**
 * Sends the model reply through a generic sender; falls back to plain text if MarkdownV2 is rejected.
 * @internal
 */
export async function sendModelTextReply(
  sender: TelegramReplySender,
  raw: string,
  replyToMessageId: number,
  messageThreadId?: number,
): Promise<void> {
  const formatted = stripThinking(raw);
  const params = {
    reply_parameters: { message_id: replyToMessageId },
    message_thread_id: messageThreadId,
  };

  try {
    await sender.reply(formatted, { ...params, parse_mode: "MarkdownV2" as const });
  } catch (error) {
    if (!isTelegramBadRequest(error)) throw error;
    await sender.reply(plainReply(raw), params);
  }
}
