import { tool } from "@lmstudio/sdk";
import { assertEquals } from "jsr:@std/assert@1";
import { z } from "zod/v3";

import { runTool } from "./helpers.ts";

Deno.test("LM Studio tool accepts async implementation", async () => {
  const smokeTool = tool({
    name: "_async_smoke",
    description: "Internal smoke test for async tool implementations",
    parameters: { value: z.string() },
    implementation: async ({ value }) => await Promise.resolve(`ok:${value}`),
  });
  const out = await runTool(smokeTool, { value: "test" });
  assertEquals(out, "ok:test");
});
