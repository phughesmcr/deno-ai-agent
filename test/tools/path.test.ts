import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { join } from "node:path";
import { resolvePath } from "../../src/tools/context.ts";

async function makeSandbox(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await Deno.makeTempDir({ prefix: "deno-ai-agent-tools-" });
  return {
    root,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("resolveToolPath allows relative file under root", async () => {
  const { root, cleanup } = await makeSandbox();
  try {
    const file = join(root, "a.txt");
    await Deno.writeTextFile(file, "hi");
    const resolved = await resolvePath({ root }, "a.txt");
    assertEquals(resolved, await Deno.realPath(file));
  } finally {
    await cleanup();
  }
});

Deno.test("resolveToolPath rejects parent traversal", async () => {
  const { root, cleanup } = await makeSandbox();
  try {
    await assertRejects(
      () => resolvePath({ root }, "../outside.txt"),
      Error,
      "Path escapes workspace",
    );
  } finally {
    await cleanup();
  }
});
