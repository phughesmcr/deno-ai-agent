import { assertEquals } from "jsr:@std/assert@1";

import type { UserInteractionResult } from "../../src/agent/tools/user-interaction.ts";

/** Mirrors mcp elicitation-handler mapping. */
function mcpResultToElicitationResponse(result: UserInteractionResult): {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
} {
  if (result.action === "accept") {
    return result.content !== undefined ? { action: "accept", content: result.content } : { action: "accept" };
  }
  return { action: result.action };
}

Deno.test("mcpResultToElicitationResponse maps accept with content", () => {
  const out = mcpResultToElicitationResponse({ action: "accept", content: { name: "x" } });
  assertEquals(out, { action: "accept", content: { name: "x" } });
});

Deno.test("mcpResultToElicitationResponse maps decline", () => {
  assertEquals(mcpResultToElicitationResponse({ action: "decline" }), { action: "decline" });
});
