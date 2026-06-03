const encoder = new TextEncoder();

/**
 * Stateful JSONL framing for a single socket connection.
 * @internal
 */
export class JsonlConnection {
  readonly #conn: Deno.Conn;
  readonly #decoder = new TextDecoder();
  readonly #readBuffer = new Uint8Array(4096);
  #pending = "";
  #eof = false;

  constructor(conn: Deno.Conn) {
    this.#conn = conn;
  }

  /** Reads one JSONL line, preserving unread bytes for later calls. */
  async readLine(): Promise<string | null> {
    while (true) {
      const index = this.#pending.indexOf("\n");
      if (index >= 0) {
        const line = this.#pending.slice(0, index);
        this.#pending = this.#pending.slice(index + 1);
        return line;
      }

      if (this.#eof) {
        if (this.#pending.length === 0) return null;
        const line = this.#pending;
        this.#pending = "";
        return line;
      }

      // deno-lint-ignore no-await-in-loop -- A JSONL frame must read sequentially from one socket.
      const n = await this.#conn.read(this.#readBuffer);
      if (n === null) {
        this.#pending += this.#decoder.decode();
        this.#eof = true;
      } else {
        this.#pending += this.#decoder.decode(this.#readBuffer.subarray(0, n), { stream: true });
      }
    }
  }

  /** Writes a UTF-8 line, retrying until the whole frame has been written. */
  async writeLine(line: string): Promise<void> {
    const bytes = encoder.encode(line.endsWith("\n") ? line : `${line}\n`);
    let written = 0;
    while (written < bytes.length) {
      // deno-lint-ignore no-await-in-loop -- Socket writes may be partial and must remain in order.
      const n = await this.#conn.write(bytes.subarray(written));
      if (n === 0) throw new Error("socket write returned 0 bytes");
      written += n;
    }
  }
}
