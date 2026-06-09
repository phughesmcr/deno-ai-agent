/** Returns true for abort-like errors produced by DOM, Deno, or model adapters. */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted && error === signal.reason) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}
