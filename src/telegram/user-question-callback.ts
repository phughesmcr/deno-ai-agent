const MAX_CALLBACK_BYTES = 64;

/**
 * Encodes option selection callback data.
 * @internal
 */
export function encodeOptionCallback(sessionId: number, optionIndex: number): string {
  return `aq:${sessionId}:o:${optionIndex}`;
}

/**
 * Encodes Other button callback data.
 * @internal
 */
export function encodeOtherCallback(sessionId: number): string {
  return `aq:${sessionId}:other`;
}

/**
 * Encodes Cancel button callback data.
 * @internal
 */
export function encodeCancelCallback(sessionId: number): string {
  return `aq:${sessionId}:cancel`;
}

/**
 * Encodes multi-select toggle callback data.
 * @internal
 */
export function encodeToggleCallback(sessionId: number, optionIndex: number): string {
  return `aq:${sessionId}:t:${optionIndex}`;
}

/**
 * Encodes multi-select Done callback data.
 * @internal
 */
export function encodeDoneCallback(sessionId: number): string {
  return `aq:${sessionId}:done`;
}

/**
 * Returns true if data belongs to this question session.
 * @internal
 */
export function isSessionCallback(data: string, sessionId: number): boolean {
  return data.startsWith(`aq:${sessionId}:`);
}

/**
 * Parses option index from option callback data, or -1.
 * @internal
 */
export function parseOptionIndex(data: string): number {
  const match = /^aq:\d+:o:(\d+)$/.exec(data);
  if (!match?.[1]) return -1;
  return Number.parseInt(match[1], 10);
}

/**
 * Parses toggle index from toggle callback data, or -1.
 * @internal
 */
export function parseToggleIndex(data: string): number {
  const match = /^aq:\d+:t:(\d+)$/.exec(data);
  if (!match?.[1]) return -1;
  return Number.parseInt(match[1], 10);
}

/**
 * Asserts callback_data length for Telegram limits (for tests).
 * @internal
 */
export function assertCallbackFits(data: string): void {
  if (new TextEncoder().encode(data).length > MAX_CALLBACK_BYTES) {
    throw new Error(`callback_data exceeds ${MAX_CALLBACK_BYTES} bytes: ${data}`);
  }
}
