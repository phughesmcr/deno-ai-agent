// deno-lint-ignore-file camelcase -- Grammy API uses snake_case keys
import { type Context, GrammyError } from "grammy";

import { escapeMarkdownV2, plainReply, stripThinking } from "../markdown.ts";

/** Sends the model reply; falls back to plain text if MarkdownV2 is rejected. */
export async function replyWithModelText(
  ctx: Context,
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
    await ctx.reply(formatted, { ...params, parse_mode: "MarkdownV2" as const });
  } catch (error) {
    if (!(error instanceof GrammyError) || error.error_code !== 400) throw error;
    await ctx.reply(plainReply(raw), params);
  }
}

/** Notifies the user that handling failed (plain text, always deliverable). */
export async function replyError(ctx: Context, messageThreadId?: number): Promise<void> {
  const text = escapeMarkdownV2("Something went wrong while handling your message. Please try again.");
  try {
    await ctx.reply(text, { parse_mode: "MarkdownV2", message_thread_id: messageThreadId });
  } catch {
    await ctx.reply("Something went wrong while handling your message. Please try again.", {
      message_thread_id: messageThreadId,
    });
  }
}
