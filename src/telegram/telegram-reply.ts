import type { Context } from "grammy";

import { escapeMarkdownV2 } from "./markdown.ts";
import { sendModelTextReply } from "./model-reply.ts";

/**
 * Sends the model reply; falls back to plain text if MarkdownV2 is rejected.
 * @internal
 */
export async function replyWithModelText(
  ctx: Context,
  raw: string | readonly string[],
  replyToMessageId: number,
  messageThreadId?: number,
): Promise<void> {
  await sendModelTextReply(
    {
      reply: (text, options) => ctx.reply(text, options),
    },
    raw,
    replyToMessageId,
    messageThreadId,
  );
}

/**
 * Notifies the user that handling failed (plain text, always deliverable).
 * @internal
 */
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
