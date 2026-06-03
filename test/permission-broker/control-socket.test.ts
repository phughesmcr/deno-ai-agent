import { assertEquals } from "jsr:@std/assert@1";

import { ControlSocketSession } from "../../src/permission-broker/control-socket.ts";

Deno.test("ControlSocketSession serializes concurrent writes", async () => {
  const chunks: string[] = [];
  let writerChain = Promise.resolve();
  const conn = {
    read: () => Promise.resolve(null),
    write: (buf: Uint8Array) => {
      const text = new TextDecoder().decode(buf);
      writerChain = writerChain.then(() => {
        chunks.push(text);
        return new Promise<void>((resolve) => setTimeout(resolve, 5));
      });
      return writerChain.then(() => buf.length);
    },
    close: () => {},
  } as unknown as Deno.Conn;

  const session = new ControlSocketSession();
  session.attach(conn);

  await Promise.all([
    session.writeLine('{"a":1}'),
    session.writeLine('{"b":2}'),
    session.writeLine('{"c":3}'),
  ]);

  assertEquals(chunks, ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n']);
});
