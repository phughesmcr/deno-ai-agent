import { assertEquals } from "jsr:@std/assert@1";
import { JsonlConnection } from "../../src/permission-broker/jsonl.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readableConn(chunks: readonly string[]): Deno.Conn {
  const encoded = chunks.map((chunk) => encoder.encode(chunk));
  let index = 0;
  return {
    read(p: Uint8Array): Promise<number | null> {
      const chunk = encoded[index];
      if (!chunk) return Promise.resolve(null);
      index += 1;
      p.set(chunk);
      return Promise.resolve(chunk.length);
    },
    write(_p: Uint8Array): Promise<number> {
      return Promise.resolve(0);
    },
    close(): void {},
  } as Deno.Conn;
}

function writableConn(maxWriteBytes: number): { conn: Deno.Conn; output: () => string; writes: () => number } {
  const chunks: Uint8Array[] = [];
  let count = 0;
  return {
    conn: {
      read(_p: Uint8Array): Promise<number | null> {
        return Promise.resolve(null);
      },
      write(p: Uint8Array): Promise<number> {
        count += 1;
        const n = Math.min(maxWriteBytes, p.length);
        chunks.push(p.slice(0, n));
        return Promise.resolve(n);
      },
      close(): void {},
    } as Deno.Conn,
    output: () => chunks.map((chunk) => decoder.decode(chunk)).join(""),
    writes: () => count,
  };
}

Deno.test("JsonlConnection returns two lines delivered in one read separately", async () => {
  const jsonl = new JsonlConnection(readableConn(['{"id":1}\n{"id":2}\n']));
  assertEquals(await jsonl.readLine(), '{"id":1}');
  assertEquals(await jsonl.readLine(), '{"id":2}');
  assertEquals(await jsonl.readLine(), null);
});

Deno.test("JsonlConnection preserves partial line across reads", async () => {
  const jsonl = new JsonlConnection(readableConn(['{"id"', ":1}\n"]));
  assertEquals(await jsonl.readLine(), '{"id":1}');
  assertEquals(await jsonl.readLine(), null);
});

Deno.test("JsonlConnection returns final unterminated line at EOF", async () => {
  const jsonl = new JsonlConnection(readableConn(['{"id":1}']));
  assertEquals(await jsonl.readLine(), '{"id":1}');
  assertEquals(await jsonl.readLine(), null);
});

Deno.test("JsonlConnection writeLine completes partial writes", async () => {
  const fake = writableConn(3);
  const jsonl = new JsonlConnection(fake.conn);
  await jsonl.writeLine('{"id":1}');
  assertEquals(fake.output(), '{"id":1}\n');
  assertEquals(fake.writes() > 1, true);
});
