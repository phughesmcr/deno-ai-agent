import * as path from "@std/path";
import { assertEquals } from "jsr:@std/assert@1";

import { createUnavailableUserInteractionPort } from "../../src/agent/tools/user-question-port.ts";
import { parseMcpToolName } from "../../src/mcp/naming.ts";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { runTool } from "../tools/helpers.ts";

const mockServer = path.fromFileUrl(
  new URL("./mock-stdio-server.ts", import.meta.url),
);

Deno.test("McpRegistry connects to stdio mock server and calls tool", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      maxToolsTotal: 40,
      servers: {
        mock: {
          command: Deno.execPath(),
          args: ["run", "-A", mockServer],
        },
      },
    }),
  );

  const registry = new McpRegistry({
    workspacePath: dir,
    userInteraction: createUnavailableUserInteractionPort(),
    elicitationEnabled: false,
  });
  await registry.connectAll();
  assertEquals(registry.connectionErrors.length, 0);

  const tools = registry.getTools();
  assertEquals(tools.length >= 1, true);
  const echo = tools.find((t) => parseMcpToolName((t as { name: string }).name)?.toolName === "echo");
  assertEquals(echo !== undefined, true);

  const result = await runTool(echo!, { text: "hi" });
  assertEquals(result.includes("echo:hi"), true);

  await registry.closeAll();
  await Deno.remove(dir, { recursive: true });
});
