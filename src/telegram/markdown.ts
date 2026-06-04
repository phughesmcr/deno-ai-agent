import { getReasoningConfig, stripReasoningFromText } from "../shared/reasoning.ts";

/** Escapes text for Telegram MarkdownV2 parse mode. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function stripReasoningTags(text: string, start: string, end: string): string {
  return text.replaceAll(start, "").replaceAll(end, "").trim();
}

/** Creates a collapsible thinking block in MarkdownV2. */
function formatThinking(thinking: string, start: string, end: string): string {
  const lines = stripReasoningTags(thinking, start, end).split("\n");
  return lines
    .map((line) => line.trim())
    .map((line, i) => (i === 0 ? `**>${escapeMarkdownV2(line)}` : `>${escapeMarkdownV2(line)}`))
    .join("\n") + "||";
}

/** Removes model thinking blocks; returns plain user-visible text (no MarkdownV2). */
export function plainReply(message: string): string {
  return stripReasoningFromText(message);
}

/** Strips model thinking blocks and formats the reply for MarkdownV2. */
export function stripThinking(message: string): string {
  const { enabled, start, end } = getReasoningConfig();
  if (!enabled) return escapeMarkdownV2(message.trim());

  const closeIndex = message.indexOf(end);
  if (closeIndex === -1) return escapeMarkdownV2(plainReply(message));

  const thinking = message.slice(0, closeIndex);
  const response = plainReply(message);
  const quoted = stripReasoningTags(thinking, start, end) ? `${formatThinking(thinking, start, end)}\n\n` : "";
  return (quoted + escapeMarkdownV2(response)).trim();
}
