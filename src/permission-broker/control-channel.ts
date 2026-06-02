import { formatControlMessage } from "./control-protocol.ts";
import { writeJsonlLine } from "./jsonl.ts";

let controlConn: Deno.Conn | undefined;
let writeChain: Promise<void> = Promise.resolve();

/** Attaches the active control socket used for outbound grant messages. */
export function attachControlConnection(conn: Deno.Conn): void {
  controlConn = conn;
}

/** Clears the active control socket. */
export function detachControlConnection(): void {
  controlConn = undefined;
  writeChain = Promise.resolve();
}

/**
 * Pre-grants a permission in the broker daemon (avoids deadlock while main blocks on broker checks).
 * @internal
 */
const GRANT_WRITE_TIMEOUT_MS = 2_000;

export async function sendControlGrant(
  permission: string,
  value: string | null,
  scope: "once" | "session" = "session",
): Promise<void> {
  const conn = controlConn;
  if (!conn) return;
  const line = formatControlMessage({ type: "grant", permission, value, scope });
  const write = writeChain.then(() => writeJsonlLine(conn, line));
  writeChain = write;
  await Promise.race([
    write,
    new Promise<void>((resolve) => setTimeout(resolve, GRANT_WRITE_TIMEOUT_MS)),
  ]);
}
