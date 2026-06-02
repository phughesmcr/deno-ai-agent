import { assertEquals } from "jsr:@std/assert@1/equals";

import { createReadTool } from "../../src/agent/tools/read.ts";
import { createWriteTool } from "../../src/agent/tools/write.ts";
import { runTool, withSandbox } from "./helpers.ts";

Deno.test("integration write then read", async () => {
  await withSandbox(async (ctx, _dir) => {
    const write = createWriteTool(ctx);
    const read = createReadTool(ctx);
    await runTool(write, { path: "note.md", content: "# Title\n\nBody" });
    assertEquals(await runTool(read, { path: "note.md" }), "# Title\n\nBody");
  });
});

Deno.test("integration concurrent writes serialize on same file", async () => {
  await withSandbox(async (ctx, dir) => {
    const write = createWriteTool(ctx);
    await Promise.all([
      runTool(write, { path: "race.txt", content: "first" }),
      runTool(write, { path: "race.txt", content: "second" }),
    ]);
    const content = await Deno.readTextFile(`${dir}/race.txt`);
    assertEquals(content === "first" || content === "second", true);
  });
});
