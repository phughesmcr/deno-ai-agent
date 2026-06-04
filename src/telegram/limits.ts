/** Telegram message character limit (API maximum). */
export const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Splits text into chunks at or below `maxLen`, preferring paragraph then line boundaries.
 */
export function splitForTelegram(text: string, maxLen: number = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  if (maxLen < 1) throw new Error("maxLen must be positive");

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    const splitAt = findSplitIndex(window, maxLen);
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function findSplitIndex(slice: string, maxLen: number): number {
  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph > 0) return paragraph + 2;

  const line = slice.lastIndexOf("\n");
  if (line > 0) return line + 1;

  return maxLen;
}
