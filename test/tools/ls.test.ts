import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createLsTool } from "../../src/tools/ls.ts";
import { toolImplementation } from "./impl.ts";

Deno.test("ls marks directories with slash", async () => {
  const root = await Deno.makeTempDir({ prefix: "ls-tool-" });
  try {
    await Deno.mkdir(`${root}/subdir`);
    await Deno.writeTextFile(`${root}/file.txt`, "");
    const run = toolImplementation<{ path?: string }, string>(createLsTool({ root }));
    const out = await run({});
    assertStringIncludes(out, "subdir/");
    assertStringIncludes(out, "file.txt");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ls empty directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "ls-tool-" });
  try {
    const empty = `${root}/empty`;
    await Deno.mkdir(empty);
    const run = toolImplementation<{ path?: string }, string>(createLsTool({ root }));
    const out = await run({ path: "empty" });
    assertEquals(out, "(empty directory)");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
