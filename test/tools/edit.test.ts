import { assertEquals } from "jsr:@std/assert@1";

import { createEditTool } from "../../src/agent/tools/edit.ts";
import { createTestWorkspace, runToolImplementation, runToolImplementationThrows } from "./helpers.ts";

Deno.test("edit replaces unique text", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/f.txt`, "alpha\nbeta\ngamma");
    const tool = createEditTool(ctx);
    await runToolImplementation(tool, {
      path: "f.txt",
      edits: [{ oldText: "beta", newText: "BETA" }],
    });
    assertEquals(await Deno.readTextFile(`${dir}/f.txt`), "alpha\nBETA\ngamma");
  } finally {
    await cleanup();
  }
});

Deno.test("edit rejects overlapping edits", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createEditTool(ctx);
    await Deno.writeTextFile(`${ctx.root}/o.txt`, "abcdef");
    const err = await runToolImplementationThrows(tool, {
      path: "o.txt",
      edits: [
        { oldText: "abc", newText: "x" },
        { oldText: "bcd", newText: "y" },
      ],
    });
    assertEquals(err.message.includes("overlap"), true);
  } finally {
    await cleanup();
  }
});

Deno.test("edit preserves CRLF line endings", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/crlf.txt`, "a\r\nb\r\n");
    const tool = createEditTool(ctx);
    await runToolImplementation(tool, {
      path: "crlf.txt",
      edits: [{ oldText: "b", newText: "B" }],
    });
    const content = await Deno.readTextFile(`${dir}/crlf.txt`);
    assertEquals(content, "a\r\nB\r\n");
  } finally {
    await cleanup();
  }
});
