import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createLsTool } from "../../src/tools/ls.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

Deno.test("ls lists entries with directory suffix", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.mkdir(`${dir}/sub`);
    await Deno.writeTextFile(`${dir}/file.txt`, "");
    const tool = createLsTool(ctx);
    const out = await runToolImplementation(tool, { path: "." });
    assertStringIncludes(out, "file.txt");
    assertStringIncludes(out, "sub/");
  } finally {
    await cleanup();
  }
});

Deno.test("ls sorts entries before applying limit", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/z.txt`, "");
    await Deno.writeTextFile(`${dir}/a.txt`, "");
    await Deno.writeTextFile(`${dir}/m.txt`, "");
    const tool = createLsTool(ctx);
    const out = await runToolImplementation(tool, { path: ".", limit: 2 });
    const lines = out.split("\n").filter((line) => line && !line.startsWith("["));
    assertEquals(lines.slice(0, 2), ["a.txt", "m.txt"]);
  } finally {
    await cleanup();
  }
});

Deno.test("ls respects entry limit", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => Deno.writeTextFile(`${dir}/f${i}.txt`, "")),
    );
    const tool = createLsTool(ctx);
    const out = await runToolImplementation(tool, { path: ".", limit: 2 });
    assertStringIncludes(out, "entries limit reached");
  } finally {
    await cleanup();
  }
});
