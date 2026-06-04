import { assertEquals } from "jsr:@std/assert@1";

import { createWriteTool } from "../../src/agent/tools/write.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

Deno.test("write creates nested file", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createWriteTool(ctx);
    const msg = await runToolImplementation(tool, { path: "nested/out.txt", content: "data" });
    assertEquals(msg.includes("Successfully wrote"), true);
    const text = await Deno.readTextFile(`${dir}/nested/out.txt`);
    assertEquals(text, "data");
  } finally {
    await cleanup();
  }
});

Deno.test("write creates host file outside workspace when given an absolute path", async () => {
  const outside = await Deno.makeTempDir({ prefix: "silas-outside-" });
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const file = `${outside}/host-write.txt`;
    const tool = createWriteTool(ctx);
    const msg = await runToolImplementation(tool, { path: file, content: "host data" });
    assertEquals(msg.includes("Successfully wrote"), true);
    assertEquals(await Deno.readTextFile(file), "host data");
  } finally {
    await cleanup();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("write overwrites existing file", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/x.txt`, "old");
    const tool = createWriteTool(ctx);
    await runToolImplementation(tool, { path: "x.txt", content: "new" });
    assertEquals(await Deno.readTextFile(`${dir}/x.txt`), "new");
  } finally {
    await cleanup();
  }
});
