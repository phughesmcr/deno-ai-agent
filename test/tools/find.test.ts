import { assertStringIncludes } from "jsr:@std/assert@1";
import { join } from "node:path";
import { createFindTool } from "../../src/tools/find.ts";
import { toolImplementation } from "./impl.ts";

Deno.test("find fallback matches glob", async () => {
  const root = await Deno.makeTempDir({ prefix: "find-tool-" });
  try {
    await Deno.writeTextFile(join(root, "one.json"), "{}");
    await Deno.writeTextFile(join(root, "two.txt"), "");
    const run = toolImplementation<{ pattern: string; limit?: number }, string>(
      createFindTool({ root }, { forceFallback: true }),
    );
    const out = await run({ pattern: "*.json", limit: 100 });
    assertStringIncludes(out, "one.json");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
