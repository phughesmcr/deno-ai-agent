import { assertStringIncludes } from "jsr:@std/assert@1";
import { join } from "node:path";
import { createGrepTool } from "../../src/tools/grep.ts";
import { toolImplementation } from "./impl.ts";

Deno.test("grep fallback finds literal pattern", async () => {
  const root = await Deno.makeTempDir({ prefix: "grep-tool-" });
  try {
    await Deno.writeTextFile(join(root, "a.txt"), "hello world\n");
    await Deno.writeTextFile(join(root, "b.txt"), "other\n");
    const run = toolImplementation<{ pattern: string; literal?: boolean; limit?: number }, string>(
      createGrepTool({ root }, { forceFallback: true }),
    );
    const out = await run({ pattern: "hello", literal: true, limit: 10 });
    assertStringIncludes(out, "a.txt:1:");
    assertStringIncludes(out, "hello");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
