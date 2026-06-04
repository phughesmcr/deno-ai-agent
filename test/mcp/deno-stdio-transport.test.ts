import * as path from "@std/path";
import { assert, assertEquals } from "jsr:@std/assert@1";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types";

import { stdioChildEnv } from "../../src/mcp/stdio-env.ts";
import { DenoStdioClientTransport } from "../../src/mcp/transports/deno-stdio.ts";

const printEnvServer = path.fromFileUrl(new URL("./print-env-json-rpc.ts", import.meta.url));
const slowSigtermServer = path.fromFileUrl(new URL("./slow-sigterm-server.ts", import.meta.url));

function onceMessage(transport: DenoStdioClientTransport): Promise<JSONRPCMessage> {
  return new Promise((resolve, reject) => {
    transport.onmessage = resolve;
    transport.onerror = reject;
  });
}

async function withTestTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return await Promise.race([promise, timeout]);
}

Deno.test("DenoStdioClientTransport does not inherit stripped broker env vars", async () => {
  const original = Deno.env.get("SILAS_PERMISSION_CONTROL_PATH");
  Deno.env.set("SILAS_PERMISSION_CONTROL_PATH", "/tmp/silas-parent-control.sock");

  const transport = new DenoStdioClientTransport({
    command: Deno.execPath(),
    args: ["run", "--allow-env=SILAS_PERMISSION_CONTROL_PATH,PATH", printEnvServer],
    env: stdioChildEnv({}),
  });

  try {
    const message = onceMessage(transport);
    await transport.start();
    const received = await withTestTimeout(message, 1000);
    const params = received.params as { controlPath: string | null };

    assertEquals(params.controlPath, null);
  } finally {
    await transport.close();
    if (original === undefined) {
      Deno.env.delete("SILAS_PERMISSION_CONTROL_PATH");
    } else {
      Deno.env.set("SILAS_PERMISSION_CONTROL_PATH", original);
    }
  }
});

Deno.test("DenoStdioClientTransport close escalates when child delays SIGTERM", async () => {
  const transport = new DenoStdioClientTransport({
    command: Deno.execPath(),
    args: ["run", slowSigtermServer],
    env: stdioChildEnv({}),
  });

  const message = onceMessage(transport);
  await transport.start();
  await withTestTimeout(message, 1000);

  const started = performance.now();
  await withTestTimeout(transport.close(), 1000);
  const elapsed = performance.now() - started;

  assert(elapsed < 1000, `close took ${elapsed}ms`);
});
