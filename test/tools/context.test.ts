import * as path from "@std/path";
import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { expandTilde } from "../../src/workspace-sandbox.ts";

import {
  createToolContext,
  isHostReadPath,
  normalizeRoot,
  normalizeUserPath,
  resolvePath,
  resolveReadPath,
} from "../../src/tools/context.ts";
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

Deno.test("resolveReadPath marks host absolute paths as outside workspace", async () => {
  const outside = await Deno.makeTempDir({ prefix: "silas-outside-" });
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const file = `${outside}/remote.txt`;
    await Deno.writeTextFile(file, "remote");
    const { absolutePath, outsideWorkspace } = await resolveReadPath(ctx, file);
    assertEquals(outsideWorkspace, true);
    assertEquals(absolutePath, path.resolve(file));
    assertEquals(isHostReadPath(file), true);
    assertEquals(isHostReadPath("notes.txt"), false);
  } finally {
    await cleanup();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("normalizeUserPath strips quotes so tilde host reads resolve", () => {
  assertEquals(normalizeUserPath("'~/.codex/config.toml'"), "~/.codex/config.toml");
  assertEquals(isHostReadPath("'~/.codex/config.toml'"), true);
});

Deno.test("resolveReadPath expands host tilde paths without filesystem canonicalization", async () => {
  const home = Deno.env.get("HOME");
  if (!home) return;
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const { absolutePath, outsideWorkspace } = await resolveReadPath(ctx, "~/.codex/config.toml");
    assertEquals(outsideWorkspace, true);
    assertEquals(absolutePath, path.resolve(expandTilde("~/.codex/config.toml")));
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
