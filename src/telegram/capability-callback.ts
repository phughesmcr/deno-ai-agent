const MAX_CALLBACK_BYTES = 64;

/** Capability prompt callback actions. */
export type CapabilityCallbackAction = "approve" | "once" | "session" | "deny";

/**
 * Encodes a capability prompt callback. Uses short ids to fit Telegram limits.
 * @internal
 */
export function encodeCapabilityCallback(shortId: string, action: CapabilityCallbackAction): string {
  return `cp:${shortId}:${action}`;
}

/** Returns true when data is a capability prompt callback. */
export function isCapabilityCallback(data: string): boolean {
  return data.startsWith("cp:");
}

/**
 * Parses capability callback data.
 * @internal
 */
export function parseCapabilityCallback(
  data: string,
): { shortId: string; action: CapabilityCallbackAction } | undefined {
  const match = /^cp:([^:]+):(approve|once|session|deny)$/.exec(data);
  if (!match?.[1] || !match[2]) return undefined;
  return { shortId: match[1], action: match[2] as CapabilityCallbackAction };
}

/**
 * Asserts callback_data length for Telegram limits (for tests).
 * @internal
 */
export function assertCapabilityCallbackFits(data: string): void {
  if (new TextEncoder().encode(data).length > MAX_CALLBACK_BYTES) {
    throw new Error(`callback_data exceeds ${MAX_CALLBACK_BYTES} bytes: ${data}`);
  }
}

/** Maps a request id to a short callback id (8 alphanumeric chars when possible). */
export function toShortCapabilityRequestId(requestId: string): string {
  const compact = requestId.replaceAll(/[^a-zA-Z0-9]/g, "");
  return compact.slice(0, 8) || "request";
}

/** Finds a pending request id from the short callback id map. */
export function resolveCapabilityRequestId(shortId: string, pending: Map<string, string>): string | undefined {
  for (const [requestId, mapped] of pending.entries()) {
    if (mapped === shortId) return requestId;
  }
  return undefined;
}
