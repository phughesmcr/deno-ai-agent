import { assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { createReadTool } from "../../src/tools/read.ts";
import { createWriteTool } from "../../src/tools/write.ts";
import { toolImplementation } from "./impl.ts";

Deno.test("write creates nested file", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-tool-" });
  try {
    const write = toolImplementation<{ path: string; content: string }, string>(createWriteTool({ root }));
    await write({ path: "nested/a.txt", content: "hello" });
    const text = await Deno.readTextFile(join(root, "nested", "a.txt"));
    assertEquals(text, "hello");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("integration write then read", async () => {
  const root = await Deno.makeTempDir({ prefix: "write-read-" });
  try {
    const write = toolImplementation<{ path: string; content: string }, string>(createWriteTool({ root }));
    const read = toolImplementation<{ path: string }, string>(createReadTool({ root }));
    await write({ path: "x.txt", content: "data" });
    const out = await read({ path: "x.txt" });
    assertEquals(out, "data");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
