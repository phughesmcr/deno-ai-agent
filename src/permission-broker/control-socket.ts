import { JsonlConnection } from "./jsonl.ts";

/**
 * One JSONL reader and serialized writer for a control Unix socket.
 * All outbound frames (register, grant, decision, prompt) must share this queue.
 * @internal
 */
export class ControlSocketSession {
  #jsonl: JsonlConnection | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  /** Binds the session to a connected control socket. */
  attach(conn: Deno.Conn): void {
    this.#jsonl = new JsonlConnection(conn);
    this.#writeChain = Promise.resolve();
  }

  /** Clears the session without closing the socket. */
  detach(): void {
    this.#jsonl = undefined;
    this.#writeChain = Promise.resolve();
  }

  /** Returns true when a socket is attached. */
  isAttached(): boolean {
    return this.#jsonl !== undefined;
  }

  /** Reads the next inbound JSONL line. */
  readLine(): Promise<string | null> {
    const jsonl = this.#jsonl;
    if (!jsonl) return Promise.resolve(null);
    return jsonl.readLine();
  }

  /** Enqueues one outbound JSONL line after prior writes complete. */
  writeLine(line: string): Promise<void> {
    const jsonl = this.#jsonl;
    if (!jsonl) return Promise.resolve();
    const write = this.#writeChain.catch(() => {}).then(() => jsonl.writeLine(line));
    this.#writeChain = write.catch(() => {});
    return write;
  }
}
