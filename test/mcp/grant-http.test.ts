import { assertEquals } from "jsr:@std/assert@1";

import { grantMcpHttpBrokerAccess } from "../../src/mcp/grant-http.ts";
import { attachControlConnection, detachControlConnection } from "../../src/permission-broker/control-channel.ts";
import { parseControlMessage } from "../../src/permission-broker/control-protocol.ts";

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

Deno.test("grantMcpHttpBrokerAccess emits a session net grant for the configured URL", async () => {
  const fake = writableConn();
  attachControlConnection(fake.conn);
  try {
    await grantMcpHttpBrokerAccess({
      id: "remote",
      enabled: true,
      transport: "http",
      url: "https://example.com/mcp",
      args: [],
      env: {},
      maxTools: 20,
    });
  } finally {
    detachControlConnection();
  }

  const messages = fake.lines().map((line) => parseControlMessage(line));
  assertEquals(messages, [
    { type: "grant", permission: "net", value: "example.com:443", scope: "session" },
  ]);
});
