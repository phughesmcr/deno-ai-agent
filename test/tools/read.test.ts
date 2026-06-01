import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { join } from "node:path";
import { createReadTool } from "../../src/tools/read.ts";
import { toolImplementation } from "./impl.ts";

Deno.test("read returns file content with offset", async () => {
  const root = await Deno.makeTempDir({ prefix: "read-tool-" });
  try {
    const file = join(root, "lines.txt");
    await Deno.writeTextFile(file, "one\ntwo\nthree\n");
    const run = toolImplementation<{ path: string; offset?: number; limit?: number }, string>(
      createReadTool({ root }),
    );
    const out = await run({ path: "lines.txt", offset: 2, limit: 1 });
    assertEquals(out.split("\n")[0], "two");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read truncation footer when many lines", async () => {
  const root = await Deno.makeTempDir({ prefix: "read-tool-" });
  try {
    const file = join(root, "big.txt");
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    await Deno.writeTextFile(file, lines);
    const run = toolImplementation<{ path: string }, string>(createReadTool({ root }));
    const out = await run({ path: "big.txt" });
    assertStringIncludes(out, "Use offset=");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
