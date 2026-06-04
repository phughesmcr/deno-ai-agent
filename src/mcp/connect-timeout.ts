/** Default MCP initialize handshake timeout (per server). */
export const MCP_CONNECT_TIMEOUT_MS = 45_000;

/** Rejects when `promise` does not settle within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timeoutId = setTimeout(() => timeout.reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  using timeoutCleanup = { [Symbol.dispose]: () => clearTimeout(timeoutId) };
  void timeoutCleanup;
  return await Promise.race([promise, timeout.promise]);
}
