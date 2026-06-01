/** Escapes text for Telegram MarkdownV2 parse mode. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** Creates a collapsible thinking block in MarkdownV2. */
function formatThinking(thinking: string): string {
  const lines = thinking.replace(/<\/?(?:redacted_thinking|think)>/g, "").trim().split("\n");
  return lines
    .map((line) => line.trim())
    .map((line, i) => (i === 0 ? `**>${escapeMarkdownV2(line)}` : `>${escapeMarkdownV2(line)}`))
    .join("\n") + "||";
}

const THINKING_END = /<\/(?:redacted_thinking|think)>/;

function thinkingCloseTagLength(message: string, endIndex: number): number {
  const slice = message.slice(endIndex);
  const match = slice.match(/^<\/(?:redacted_thinking|think)>/);
  return match?.[0].length ?? 0;
}

/** Removes model thinking blocks; returns plain user-visible text (no MarkdownV2). */
export function plainReply(message: string): string {
  const end = message.search(THINKING_END);
  if (end === -1) return message.replace(/<\/?(?:redacted_thinking|think)>/g, "").trim();
  return message.slice(end + thinkingCloseTagLength(message, end)).trim();
}

/** Strips model thinking blocks and formats the reply for MarkdownV2. */
export function stripThinking(message: string): string {
  const end = message.search(THINKING_END);
  if (end === -1) return escapeMarkdownV2(plainReply(message));
  const thinking = message.slice(0, end);
  const response = plainReply(message);
  const quoted = thinking.replace(/<\/?(?:redacted_thinking|think)>/g, "").trim() ?
    `${formatThinking(thinking)}\n\n` :
    "";
  return (quoted + escapeMarkdownV2(response)).trim();
}
