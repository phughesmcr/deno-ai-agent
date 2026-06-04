import { formatControlMessage } from "./control-protocol.ts";
import { ControlSocketSession } from "./control-socket.ts";
import { logError } from "./log.ts";

const CONTROL_WRITE_TIMEOUT_MS = 5_000;

const controlSession = new ControlSocketSession();

function writeTimedOut(): Error {
  return new Error(`Control socket write timed out after ${CONTROL_WRITE_TIMEOUT_MS}ms.`);
}

/** Attaches the active control socket used by the Silas control client. */
export function attachControlConnection(conn: Deno.Conn): void {
  controlSession.attach(conn);
}

/** Clears the active control socket. */
export function detachControlConnection(): void {
  controlSession.detach();
}

/** Reads the next inbound control message line. */
export function readControlLine(): Promise<string | null> {
  return controlSession.readLine();
}

/** Writes one outbound control message line in order with other writers. */
export async function writeControlLine(line: string, signal?: AbortSignal): Promise<void> {
  if (!controlSession.isAttached()) return;
  if (signal?.aborted) return;

  const timeout = Promise.withResolvers<never>();
  const timeoutId = setTimeout(() => timeout.reject(writeTimedOut()), CONTROL_WRITE_TIMEOUT_MS);
  using timeoutCleanup = { [Symbol.dispose]: () => clearTimeout(timeoutId) };
  void timeoutCleanup;
  const onAbort = (): void => {
    clearTimeout(timeoutId);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await Promise.race([controlSession.writeLine(line), timeout.promise]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Pre-grants a permission in the broker daemon.
 * @internal
 */
export async function sendControlGrant(
  permission: string,
  value: string | null,
  signal?: AbortSignal,
  scope: "once" | "session" = "session",
): Promise<void> {
  if (!controlSession.isAttached()) return;
  const line = formatControlMessage({ type: "grant", permission, value, scope });
  try {
    await writeControlLine(line, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError("permission_broker.control_grant_failed", { permission, message });
  }
}
