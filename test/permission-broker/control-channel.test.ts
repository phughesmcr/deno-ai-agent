import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  attachControlConnection,
  ControlGrantWriter,
  detachControlConnection,
} from "../../src/permission-broker/control-channel.ts";
import { parseControlMessage } from "../../src/permission-broker/control-protocol.ts";
import { grantBrokerReadPath, grantBrokerRunValues } from "../../src/permission-broker/mod.ts";

const decoder = new TextDecoder();

function writableConn(): { conn: Deno.Conn; lines: () => string[]; closed: () => boolean } {
  const chunks: Uint8Array[] = [];
  let isClosed = false;
  return {
    conn: {
      read(_p: Uint8Array): Promise<number | null> {
        return Promise.resolve(null);
      },
      write(p: Uint8Array): Promise<number> {
        chunks.push(p.slice());
        return Promise.resolve(p.length);
      },
      close(): void {
        isClosed = true;
      },
    } as Deno.Conn,
    lines: () => decoder.decode(concat(chunks)).trim().split("\n").filter((line) => line.length > 0),
    closed: () => isClosed,
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

function hangingConn(): { conn: Deno.Conn; closed: () => boolean } {
  let isClosed = false;
  return {
    conn: {
      read(_p: Uint8Array): Promise<number | null> {
        return Promise.resolve(null);
      },
      write(_p: Uint8Array): Promise<number> {
        return new Promise(() => {});
      },
      close(): void {
        isClosed = true;
      },
    } as Deno.Conn,
    closed: () => isClosed,
  };
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

Deno.test("ControlGrantWriter recovers after failed write and reconnect", async () => {
  const writer = new ControlGrantWriter(50);
  writer.attach(failingConn());
  await assertRejects(() => writer.grant("run", "/bin/sh", "session"));

  const next = writableConn();
  writer.attach(next.conn);
  await writer.grant("run", "/usr/bin/env", "session");

  const [line] = next.lines();
  assertEquals(parseControlMessage(line!).type, "grant");
  assertEquals(parseControlMessage(line!), {
    type: "grant",
    permission: "run",
    value: "/usr/bin/env",
    scope: "session",
  });
});

Deno.test("ControlGrantWriter timeout clears and closes active connection", async () => {
  const writer = new ControlGrantWriter(10);
  const hung = hangingConn();
  writer.attach(hung.conn);

  await assertRejects(() => writer.grant("run", "/bin/sh", "session"));
  assertEquals(hung.closed(), true);
});

Deno.test("broker grant facades emit read and run grant messages", async () => {
  const fake = writableConn();
  attachControlConnection(fake.conn);
  try {
    await grantBrokerReadPath("/tmp/config.toml");
    await grantBrokerRunValues(["/bin/sh", "/bin/sh", "/usr/bin/env"]);
  } finally {
    detachControlConnection();
  }

  const messages = fake.lines().map((line) => parseControlMessage(line));
  assertEquals(messages, [
    { type: "grant", permission: "read", value: "/tmp/config.toml", scope: "session" },
    { type: "grant", permission: "read", value: '"/tmp/config.toml"', scope: "session" },
    { type: "grant", permission: "run", value: "/bin/sh", scope: "session" },
    { type: "grant", permission: "run", value: "/usr/bin/env", scope: "session" },
  ]);
});
