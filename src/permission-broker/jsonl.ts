const decoder = new TextDecoder();

/**
 * Reads one JSONL line from a connection.
 * @internal
 */
export async function readJsonlLine(conn: Deno.Conn): Promise<string | null> {
  const buffer = new Uint8Array(4096);
  let pending = "";
  while (true) {
    const n = await conn.read(buffer);
    if (n === null) return pending.length > 0 ? pending : null;
    pending += decoder.decode(buffer.subarray(0, n));
    const index = pending.indexOf("\n");
    if (index >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      return line;
    }
  }
}

/** Writes a UTF-8 line to a connection. */
export async function writeJsonlLine(conn: Deno.Conn, line: string): Promise<void> {
  await conn.write(new TextEncoder().encode(line.endsWith("\n") ? line : `${line}\n`));
}
