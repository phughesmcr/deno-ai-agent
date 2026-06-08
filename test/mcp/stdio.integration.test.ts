import * as path from "@std/path";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

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

Deno.test("McpRegistry exposes prompt and resource meta-tools", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      maxToolsTotal: 40,
      servers: {
        mock: {
          command: Deno.execPath(),
          args: ["run", "-A", mockServer, "--with-prompts-resources"],
        },
      },
    }),
  );

  const registry = new McpRegistry({
    workspacePath: dir,
    userInteraction: createUnavailableUserInteractionPort(),
    elicitationEnabled: false,
  });
  try {
    await registry.connectAll();
    assertEquals(registry.connectionErrors.length, 0);
    assertEquals(registry.systemPromptAppendix.includes("mock/review"), true);
    assertEquals(registry.systemPromptAppendix.includes("file:///workspace/guide.md"), true);

    const tools = registry.getTools();
    const promptTool = tools.find((t) => parseMcpToolName((t as { name: string }).name)?.toolName === "mcp_get_prompt");
    const resourceTool = tools.find((t) =>
      parseMcpToolName((t as { name: string }).name)?.toolName === "mcp_read_resource"
    );

    assertEquals(promptTool !== undefined, true);
    assertEquals(resourceTool !== undefined, true);
    assertEquals(
      await runTool(promptTool!, { name: "review", arguments: { topic: "durability" } }),
      [
        "[user] review:durability",
      ].join("\n\n"),
    );
    assertEquals(
      await runTool(resourceTool!, { uri: "file:///workspace/guide.md" }),
      "Durable MCP resource text.",
    );
  } finally {
    await registry.closeAll();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("McpRegistry lists MCP tools omitted by global and per-server budgets", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      maxToolsTotal: 2,
      servers: {
        mock: {
          command: Deno.execPath(),
          args: ["run", "-A", mockServer, "--many-tools"],
          maxTools: 3,
        },
      },
    }),
  );

  const registry = new McpRegistry({
    workspacePath: dir,
    userInteraction: createUnavailableUserInteractionPort(),
    elicitationEnabled: false,
  });
  try {
    await registry.connectAll();

    const toolNames = registry.getTools().flatMap((tool) => {
      const parsed = parseMcpToolName((tool as { name: string }).name);
      return parsed ? [parsed.toolName] : [];
    });
    assertEquals(toolNames, ["echo", "inspect"]);
    assertStringIncludes(registry.systemPromptAppendix, "search");
    assertStringIncludes(registry.systemPromptAppendix, "summarize");
  } finally {
    await registry.closeAll();
    await Deno.remove(dir, { recursive: true });
  }
});
