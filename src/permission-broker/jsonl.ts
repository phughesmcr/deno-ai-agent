const encoder = new TextEncoder();

/**
 * Stateful JSONL framing for a single socket connection.
 * @internal
 */
export class JsonlConnection {
  private readonly _conn: Deno.Conn;
  private readonly _decoder = new TextDecoder();
  private readonly _readBuffer = new Uint8Array(4096);
  private _pending = "";
  private _eof = false;

  constructor(conn: Deno.Conn) {
    this._conn = conn;
  }

  /** Reads one JSONL line, preserving unread bytes for later calls. */
  async readLine(): Promise<string | null> {
    while (true) {
      const index = this._pending.indexOf("\n");
      if (index >= 0) {
        const line = this._pending.slice(0, index);
        this._pending = this._pending.slice(index + 1);
        return line;
      }

      if (this._eof) {
        if (this._pending.length === 0) return null;
        const line = this._pending;
        this._pending = "";
        return line;
      }

      // deno-lint-ignore no-await-in-loop -- A JSONL frame must read sequentially from one socket.
      const n = await this._conn.read(this._readBuffer);
      if (n === null) {
        this._pending += this._decoder.decode();
        this._eof = true;
      } else {
        this._pending += this._decoder.decode(this._readBuffer.subarray(0, n), { stream: true });
      }
    }
  }

  /** Writes a UTF-8 line, retrying until the whole frame has been written. */
  async writeLine(line: string): Promise<void> {
    const bytes = encoder.encode(line.endsWith("\n") ? line : `${line}\n`);
    let written = 0;
    while (written < bytes.length) {
      // deno-lint-ignore no-await-in-loop -- Socket writes may be partial and must remain in order.
      const n = await this._conn.write(bytes.subarray(written));
      if (n === 0) throw new Error("socket write returned 0 bytes");
      written += n;
    }
  }
}
