// deno-lint-ignore-file camelcase -- Telegram API uses snake_case keys
import { splitForTelegram, TELEGRAM_MAX_LENGTH } from "./limits.ts";
import { plainReply, stripThinking } from "./markdown.ts";

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

type ModelReplyText = string | readonly string[];

function isTelegramBadRequest(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "error_code" in error && error.error_code === 400,
  );
}

function replyChunks(raw: ModelReplyText): readonly string[] {
  return typeof raw === "string" ? [raw] : raw;
}

/** @internal */
export function formatMarkdownReply(raw: ModelReplyText): string {
  return replyChunks(raw).map(stripThinking).filter(Boolean).join("\n\n");
}

function formatPlainReply(raw: ModelReplyText): string {
  return replyChunks(raw).map(plainReply).filter(Boolean).join("\n\n");
}

/** Aligns plain-text segments to the same chunk count as formatted MarkdownV2. */
function plainChunksForMarkdown(markdown: string, plain: string): string[] {
  const mdChunks = splitForTelegram(markdown);
  if (mdChunks.length <= 1) return [plain];

  const chunks: string[] = [];
  let rest = plain;
  for (let i = 0; i < mdChunks.length - 1; i++) {
    const remainingParts = mdChunks.length - i;
    const target = Math.ceil(rest.length / remainingParts);
    const slice = rest.slice(0, Math.min(target, rest.length));
    const splitAt = findPlainSplitIndex(slice, target);
    const piece = rest.slice(0, splitAt).trimEnd();
    chunks.push(piece);
    rest = rest.slice(splitAt).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function findPlainSplitIndex(slice: string, target: number): number {
  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph > 0) return paragraph + 2;
  const line = slice.lastIndexOf("\n");
  if (line > 0) return line + 1;
  return Math.min(target, slice.length);
}

async function sendOneChunk(
  sender: TelegramReplySender,
  markdown: string,
  plain: string,
  baseParams: Omit<TelegramReplyOptions, "parse_mode">,
): Promise<void> {
  if (markdown.length <= TELEGRAM_MAX_LENGTH) {
    try {
      await sender.reply(markdown, { ...baseParams, parse_mode: "MarkdownV2" as const });
      return;
    } catch (error) {
      if (!isTelegramBadRequest(error)) throw error;
    }
  }
  await sender.reply(plain, baseParams);
}

/**
 * Sends the model reply through a generic sender; splits long text; falls back to plain text per chunk.
 * @internal
 */
export async function sendModelTextReply(
  sender: TelegramReplySender,
  raw: ModelReplyText,
  replyToMessageId?: number,
  messageThreadId?: number,
): Promise<void> {
  const markdown = formatMarkdownReply(raw);
  const plain = formatPlainReply(raw);
  const mdChunks = splitForTelegram(markdown);
  const plainChunks = plainChunksForMarkdown(markdown, plain);

  for (let i = 0; i < mdChunks.length; i++) {
    const baseParams: Omit<TelegramReplyOptions, "parse_mode"> = {
      message_thread_id: messageThreadId,
      ...(i === 0 && replyToMessageId !== undefined ? { reply_parameters: { message_id: replyToMessageId } } : {}),
    };
    await sendOneChunk(sender, mdChunks[i]!, plainChunks[i] ?? plain, baseParams);
  }
}
