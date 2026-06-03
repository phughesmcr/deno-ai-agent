import { formatControlMessage } from "./control-protocol.ts";
import { JsonlConnection } from "./jsonl.ts";

const GRANT_WRITE_TIMEOUT_MS = 2_000;

/** Sequential writer for broker control grant messages. */
export class ControlGrantWriter {
  readonly #timeoutMs: number;
  #rawConn: Deno.Conn | undefined;
  #jsonlConn: JsonlConnection | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(timeoutMs = GRANT_WRITE_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  /** Attaches the active control socket used for outbound grant messages. */
  attach(conn: Deno.Conn): void {
    this.#rawConn = conn;
    this.#jsonlConn = new JsonlConnection(conn);
    this.#writeChain = Promise.resolve();
  }

  /** Clears the active control socket. */
  detach(): void {
    this.#rawConn = undefined;
    this.#jsonlConn = undefined;
    this.#writeChain = Promise.resolve();
  }

  /**
   * Pre-grants a permission in the broker daemon.
   * @internal
   */
  async grant(
    permission: string,
    value: string | null,
    scope: "once" | "session" = "session",
  ): Promise<void> {
    const write = this.#writeChain.catch(() => {}).then(() => this.#writeGrant(permission, value, scope));
    this.#writeChain = write.catch(() => {});
    await write;
  }

  async #writeGrant(permission: string, value: string | null, scope: "once" | "session"): Promise<void> {
    const rawConn = this.#rawConn;
    const jsonlConn = this.#jsonlConn;
    if (!rawConn || !jsonlConn) return;

    const line = formatControlMessage({ type: "grant", permission, value, scope });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        this.#clearActive(rawConn, true);
        reject(new Error("Control grant write timed out."));
      }, this.#timeoutMs);
    });

    try {
      await Promise.race([jsonlConn.writeLine(line), timeout]);
    } catch (error) {
      if (!timedOut) this.#clearActive(rawConn, true);
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  #clearActive(conn: Deno.Conn, close: boolean): void {
    if (this.#rawConn !== conn) return;
    this.#rawConn = undefined;
    this.#jsonlConn = undefined;
    if (close) {
      try {
        conn.close();
      } catch {
        /* already closed */
      }
    }
  }
}

const controlGrantWriter = new ControlGrantWriter();

/** Attaches the active control socket used for outbound grant messages. */
export function attachControlConnection(conn: Deno.Conn): void {
  controlGrantWriter.attach(conn);
}

/** Clears the active control socket. */
export function detachControlConnection(): void {
  controlGrantWriter.detach();
}

/**
 * Pre-grants a permission in the broker daemon.
 * @internal
 */
export async function sendControlGrant(
  permission: string,
  value: string | null,
  scope: "once" | "session" = "session",
): Promise<void> {
  await controlGrantWriter.grant(permission, value, scope);
}
