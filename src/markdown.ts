/** Escapes text for Telegram MarkdownV2 parse mode. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** Creates a collapsible thinking block in MarkdownV2. */
function formatThinking(thinking: string): string {
  const lines = thinking.replace("<think>", "").replace("</think>", "").trim().split("\n");
  return lines
    .map((line) => line.trim())
    .map((line, i) => (i === 0 ? `**>${escapeMarkdownV2(line)}` : `>${escapeMarkdownV2(line)}`))
    .join("\n") + "||";
}

/** Strips model thinking blocks and formats the reply for MarkdownV2. */
export function stripThinking(message: string): string {
  const match = message.match(/^([\s\S]*?)<\/think>([\s\S]*)$/);
  if (!match) return escapeMarkdownV2(message.trim());
  const thinking = match[1] ?? "";
  const response = match[2] ?? "";
  const quoted = thinking.trim() ? `${formatThinking(thinking)}\n\n` : "";
  return (quoted + escapeMarkdownV2(response.trim())).trim();
}
