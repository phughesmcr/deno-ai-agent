import { assertStringIncludes } from "jsr:@std/assert@1/string-includes";

import { createToolContext } from "../../src/agent/tools/context.ts";
import { createLsTool } from "../../src/agent/tools/ls.ts";
import { withRecoverableToolErrors } from "../../src/agent/tools/tool-errors.ts";
import { runTool } from "./helpers.ts";

Deno.test("withRecoverableToolErrors returns sandbox failures as tool text", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-tool-errors-" });
  try {
    const ctx = await createToolContext(dir, {
      sessionId: "test-session",
      turnId: "test-turn",
    });
    const tool = withRecoverableToolErrors(createLsTool(ctx));
    const result = await runTool(tool, { path: ".." });
    assertStringIncludes(result, "Error:");
    assertStringIncludes(result, "Path escapes workspace");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
