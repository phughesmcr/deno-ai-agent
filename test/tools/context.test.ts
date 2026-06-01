import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { createToolContext, normalizeRoot, resolvePath } from "../../src/tools/context.ts";
import { createTestWorkspace } from "./helpers.ts";

Deno.test("resolvePath accepts relative path under workspace", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const filePath = `${dir}/hello.txt`;
    await Deno.writeTextFile(filePath, "hi");
    const resolved = await resolvePath(ctx, "hello.txt");
    assertEquals(resolved, await Deno.realPath(filePath));
  } finally {
    await cleanup();
  }
});

Deno.test("resolvePath rejects path escape via ..", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    await assertRejects(
      () => resolvePath(ctx, "../outside.txt"),
      Error,
      "Path escapes workspace",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("createToolContext normalizes trailing separator", async () => {
  const ctx = await createToolContext("/tmp/workspace/");
  if (ctx.root !== "/") {
    assertEquals(ctx.root.endsWith("/"), false);
  }
  assertEquals(normalizeRoot("/tmp/workspace/").replace(/\/+$/, ""), ctx.root.replace(/\/+$/, ""));
});
