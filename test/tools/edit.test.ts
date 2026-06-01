import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { join } from "node:path";
import { createEditTool } from "../../src/tools/edit.ts";
import { toolImplementation } from "./impl.ts";

Deno.test("edit replaces unique text", async () => {
  const root = await Deno.makeTempDir({ prefix: "edit-tool-" });
  try {
    const file = join(root, "f.txt");
    await Deno.writeTextFile(file, "alpha beta gamma");
    const edit = toolImplementation<
      { path: string; edits: { oldText: string; newText: string }[] },
      string
    >(createEditTool({ root }));
    await edit({
      path: "f.txt",
      edits: [{ oldText: "beta", newText: "BETA" }],
    });
    assertEquals(await Deno.readTextFile(file), "alpha BETA gamma");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("edit rejects overlapping edits", async () => {
  const root = await Deno.makeTempDir({ prefix: "edit-tool-" });
  try {
    await Deno.writeTextFile(join(root, "f.txt"), "abcdef");
    const edit = toolImplementation<
      { path: string; edits: { oldText: string; newText: string }[] },
      string
    >(createEditTool({ root }));
    await assertRejects(
      () =>
        edit({
          path: "f.txt",
          edits: [
            { oldText: "abc", newText: "1" },
            { oldText: "bcd", newText: "2" },
          ],
        }),
      Error,
      "overlap",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
