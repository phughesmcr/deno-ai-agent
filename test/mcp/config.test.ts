import * as path from "@std/path";
import { assertEquals } from "jsr:@std/assert@1";

import { loadMcpConfig } from "../../src/mcp/config.ts";

Deno.test("loadMcpConfig returns empty when mcp.json missing", async () => {
  const dir = await Deno.makeTempDir();
  const cfg = await loadMcpConfig(dir);
  assertEquals(cfg.servers.length, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadMcpConfig parses servers", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      maxToolsTotal: 10,
      servers: {
        demo: { url: "http://127.0.0.1:9999/mcp", maxTools: 5 },
      },
    }),
  );
  const cfg = await loadMcpConfig(dir);
  assertEquals(cfg.maxToolsTotal, 10);
  assertEquals(cfg.servers.length, 1);
  assertEquals(cfg.servers[0]?.id, "demo");
  assertEquals(cfg.servers[0]?.transport, "http");
  await Deno.remove(dir, { recursive: true });
});
