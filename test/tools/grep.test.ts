import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createGrepTool } from "../../src/agent/tools/grep.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

Deno.test("grep finds pattern with built-in walker", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/one.txt`, "findme here");
    await Deno.writeTextFile(`${dir}/two.txt`, "nothing");
    const tool = createGrepTool(ctx);
    const out = await runToolImplementation(tool, { pattern: "findme", literal: true });
    assertStringIncludes(out, "one.txt");
    assertStringIncludes(out, "findme");
  } finally {
    await cleanup();
  }
});

Deno.test("grep path targeting a file searches only that file", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/target.txt`, "no match");
    await Deno.writeTextFile(`${dir}/sibling.txt`, "needle");
    const tool = createGrepTool(ctx);
    const out = await runToolImplementation(tool, { pattern: "needle", literal: true, path: "target.txt" });
    assertEquals(out, "No matches found");
  } finally {
    await cleanup();
  }
});

Deno.test("grep includes context lines in fallback output", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/one.txt`, "before\nneedle\nafter");
    const tool = createGrepTool(ctx);
    const out = await runToolImplementation(tool, { pattern: "needle", literal: true, context: 1 });
    assertStringIncludes(out, "one.txt:1- before");
    assertStringIncludes(out, "one.txt:2: needle");
    assertStringIncludes(out, "one.txt:3- after");
  } finally {
    await cleanup();
  }
});
