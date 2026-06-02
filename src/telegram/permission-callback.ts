const MAX_CALLBACK_BYTES = 64;

/** Permission prompt callback actions. */
export type PermissionCallbackAction = "once" | "session" | "deny";

/**
 * Encodes a permission prompt callback. Uses short ids to fit Telegram limits.
 * @internal
 */
export function encodePermissionCallback(shortId: string, action: PermissionCallbackAction): string {
  return `pm:${shortId}:${action}`;
}

/** Returns true when data is a permission prompt callback. */
export function isPermissionCallback(data: string): boolean {
  return data.startsWith("pm:");
}

/**
 * Parses permission callback data.
 * @internal
 */
export function parsePermissionCallback(
  data: string,
): { shortId: string; action: PermissionCallbackAction } | undefined {
  const match = /^pm:([^:]+):(once|session|deny)$/.exec(data);
  if (!match?.[1] || !match[2]) return undefined;
  return { shortId: match[1], action: match[2] as PermissionCallbackAction };
}

/**
 * Asserts callback_data length for Telegram limits (for tests).
 * @internal
 */
export function assertPermissionCallbackFits(data: string): void {
  if (new TextEncoder().encode(data).length > MAX_CALLBACK_BYTES) {
    throw new Error(`callback_data exceeds ${MAX_CALLBACK_BYTES} bytes: ${data}`);
  }
}

/** Maps a UUID request id to a short callback id (8 hex chars). */
export function toShortRequestId(requestId: string): string {
  return requestId.replaceAll("-", "").slice(0, 8);
}

/** Finds a pending request id from the short callback id map. */
export function resolveRequestId(shortId: string, pending: Map<string, string>): string | undefined {
  for (const [requestId, mapped] of pending.entries()) {
    if (mapped === shortId) return requestId;
  }
  return undefined;
}
