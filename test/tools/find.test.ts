import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createFindTool } from "../../src/tools/find.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

Deno.test("find matches glob with built-in walker", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/a.json`, "{}");
    await Deno.writeTextFile(`${dir}/b.txt`, "");
    const tool = createFindTool(ctx);
    const out = await runToolImplementation(tool, { pattern: "*.json" });
    assertStringIncludes(out, "a.json");
  } finally {
    await cleanup();
  }
});

Deno.test("find returns files only", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.mkdir(`${dir}/match.json`);
    await Deno.writeTextFile(`${dir}/match-file.json`, "{}");
    const tool = createFindTool(ctx);
    const out = await runToolImplementation(tool, { pattern: "*.json" });
    assertStringIncludes(out, "match-file.json");
    assertEquals(out.includes("match.json/"), false);
  } finally {
    await cleanup();
  }
});
