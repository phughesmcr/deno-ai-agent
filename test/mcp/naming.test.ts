import { assertEquals } from "jsr:@std/assert@1";

import { formatMcpToolName, parseMcpToolName } from "../../src/mcp/naming.ts";

Deno.test("format and parse MCP tool names", () => {
  const name = formatMcpToolName("docs", "search");
  assertEquals(name, "mcp__docs__search");
  assertEquals(parseMcpToolName(name), { serverId: "docs", toolName: "search" });
});
