import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  attachControlConnection,
  detachControlConnection,
  writeControlLine,
} from "../../src/permission-broker/control-channel.ts";
import { parseControlMessage } from "../../src/permission-broker/control-protocol.ts";
import { grantBrokerNetUrl, grantBrokerReadPath, grantBrokerRunValues } from "../../src/permission-broker/mod.ts";

const decoder = new TextDecoder();

function writableConn(): { conn: Deno.Conn; lines: () => string[] } {
  const chunks: Uint8Array[] = [];
  return {
    conn: {
      read(_p: Uint8Array): Promise<number | null> {
        return Promise.resolve(null);
      },
      write(p: Uint8Array): Promise<number> {
        chunks.push(p.slice());
        return Promise.resolve(p.length);
      },
      close(): void {},
    } as Deno.Conn,
    lines: () => decoder.decode(concat(chunks)).trim().split("\n").filter((line) => line.length > 0),
  };
}

function failingConn(): Deno.Conn {
  return {
    read(_p: Uint8Array): Promise<number | null> {
      return Promise.resolve(null);
    },
    write(_p: Uint8Array): Promise<number> {
      return Promise.reject(new Error("write failed"));
    },
    close(): void {},
  } as Deno.Conn;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

Deno.test("writeControlLine recovers after failed write and reconnect", async () => {
  attachControlConnection(failingConn());
  await assertRejects(() =>
    writeControlLine('{"type":"grant","permission":"run","value":"/bin/sh","scope":"session"}')
  );

  const next = writableConn();
  attachControlConnection(next.conn);
  await writeControlLine('{"type":"grant","permission":"run","value":"/usr/bin/env","scope":"session"}');

  const [line] = next.lines();
  assertEquals(parseControlMessage(line!), {
    type: "grant",
    permission: "run",
    value: "/usr/bin/env",
    scope: "session",
  });
  detachControlConnection();
});

Deno.test("broker grant facades emit read, run, and net grant messages", async () => {
  const fake = writableConn();
  attachControlConnection(fake.conn);
  try {
    await grantBrokerReadPath("/tmp/config.toml");
    await grantBrokerRunValues([null], undefined, "once");
    await grantBrokerRunValues(["/bin/sh", "/bin/sh", "/usr/bin/env"]);
    await grantBrokerNetUrl(new URL("https://example.com/docs"), "once");
    await grantBrokerNetUrl(new URL("http://example.org:8080/docs"), "once");
  } finally {
    detachControlConnection();
  }

  const messages = fake.lines().map((line) => parseControlMessage(line));
  assertEquals(messages, [
    { type: "grant", permission: "read", value: "/tmp/config.toml", scope: "session" },
    { type: "grant", permission: "read", value: '"/tmp/config.toml"', scope: "session" },
    { type: "grant", permission: "run", value: null, scope: "once" },
    { type: "grant", permission: "run", value: "/bin/sh", scope: "session" },
    { type: "grant", permission: "run", value: "/usr/bin/env", scope: "session" },
    { type: "grant", permission: "net", value: "example.com:443", scope: "once" },
    { type: "grant", permission: "net", value: "example.org:8080", scope: "once" },
  ]);
});
