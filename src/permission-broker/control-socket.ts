import { JsonlConnection } from "./jsonl.ts";

/**
 * One JSONL reader and serialized writer for a control Unix socket.
 * All outbound frames (register, grant, decision, prompt) must share this queue.
 * @internal
 */
export class ControlSocketSession {
  private _jsonl: JsonlConnection | undefined;
  private _writeChain: Promise<void> = Promise.resolve();

  /** Binds the session to a connected control socket. */
  attach(conn: Deno.Conn): void {
    this._jsonl = new JsonlConnection(conn);
    this._writeChain = Promise.resolve();
  }

  /** Clears the session without closing the socket. */
  detach(): void {
    this._jsonl = undefined;
    this._writeChain = Promise.resolve();
  }

  /** Returns true when a socket is attached. */
  isAttached(): boolean {
    return this._jsonl !== undefined;
  }

  /** Reads the next inbound JSONL line. */
  readLine(): Promise<string | null> {
    const jsonl = this._jsonl;
    if (!jsonl) return Promise.resolve(null);
    return jsonl.readLine();
  }

  /** Enqueues one outbound JSONL line after prior writes complete. */
  writeLine(line: string): Promise<void> {
    const jsonl = this._jsonl;
    if (!jsonl) return Promise.resolve();
    const write = this._writeChain.catch(() => {}).then(() => jsonl.writeLine(line));
    this._writeChain = write.catch(() => {});
    return write;
  }
}
