import * as path from "@std/path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";

import { expandTilde } from "../../src/agent/workspace-sandbox.ts";
import { createToolContext, normalizeRoot } from "../../src/agent/tools/context.ts";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../../src/shared/approval.ts";
import { createTestWorkspace } from "./helpers.ts";

Deno.test("ToolFilesystem resolves workspace-relative paths inside root", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const filePath = `${dir}/hello.txt`;
    await Deno.writeTextFile(filePath, "hi");

    const op = await ctx.fs.operation({
      operation: "read",
      path: "hello.txt",
      access: "read",
      require: "existingFile",
      summary: "read text",
    });

    assertEquals(op.target.absolutePath, await Deno.realPath(filePath));
    assertEquals(op.target.displayPath, "hello.txt");
    assertEquals(op.target.outsideWorkspace, false);
    assertEquals(op.target.kind, "file");
  } finally {
    await cleanup();
  }
});

Deno.test("ToolFilesystem rejects workspace .. escapes", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    await assertRejects(
      () =>
        ctx.fs.operation({
          operation: "read",
          path: "../outside.txt",
          access: "read",
          summary: "read text",
        }),
      Error,
      "Path escapes workspace",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("ToolFilesystem rejects absolute in-workspace symlink escapes", async () => {
  const outside = await Deno.makeTempDir({ prefix: "silas-outside-" });
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${outside}/secret.txt`, "secret");
    await Deno.symlink(outside, `${ctx.root}/escape`);

    await assertRejects(
      () =>
        ctx.fs.operation({
          operation: "read",
          path: `${ctx.root}/escape/secret.txt`,
          access: "read",
          summary: "read text",
        }),
      Error,
      "Path escapes workspace",
    );
  } finally {
    await cleanup();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("ToolFilesystem treats absolute in-workspace paths as workspace paths", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${ctx.root}/notes.txt`, "notes");
    const op = await ctx.fs.operation({
      operation: "read",
      path: `${ctx.root}/notes.txt`,
      access: "read",
      require: "existingFile",
      summary: "read text",
    });

    assertEquals(op.target.outsideWorkspace, false);
    assertEquals(op.target.displayPath, "notes.txt");
  } finally {
    await cleanup();
  }
});

Deno.test("ToolFilesystem resolves host absolute paths only when allowed", async () => {
  const outside = await Deno.makeTempDir({ prefix: "silas-outside-" });
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const file = `${outside}/remote.txt`;
    await Deno.writeTextFile(file, "remote");
    const op = await ctx.fs.operation({
      operation: "read",
      path: file,
      access: "read",
      require: "existingFile",
      summary: "read text",
    });

    assertEquals(op.target.outsideWorkspace, true);
    assertEquals(op.target.absolutePath, path.resolve(file));
    assertEquals(op.target.displayPath, path.resolve(file));

    const scoped = ctx.fs.scoped({ allowHostPaths: false });
    await assertRejects(
      () =>
        scoped.operation({
          operation: "read",
          path: file,
          access: "read",
          summary: "read text",
        }),
      Error,
      "Host paths are not available",
    );
  } finally {
    await cleanup();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("ToolFilesystem strips path quotes and expands host tilde paths", async () => {
  const home = Deno.env.get("HOME");
  if (!home) return;
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const op = await ctx.fs.operation({
      operation: "read",
      path: "'~/.codex/config.toml'",
      access: "read",
      summary: "read text",
    });

    assertEquals(op.target.inputPath, "~/.codex/config.toml");
    assertEquals(op.target.outsideWorkspace, true);
    assertEquals(op.target.absolutePath, path.resolve(expandTilde("~/.codex/config.toml")));
  } finally {
    await cleanup();
  }
});

Deno.test("ToolFilesystem approval requests match workspace and host risk behavior", async () => {
  const outside = await Deno.makeTempDir({ prefix: "silas-outside-" });
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/workspace.txt`, "workspace");
    await Deno.writeTextFile(`${outside}/host.txt`, "host");

    const workspaceRequest = (await ctx.fs.operation({
      operation: "write",
      path: "workspace.txt",
      access: "write",
      workspaceRisk: "medium",
      summary: "write 9 bytes",
    })).approvalRequest();
    assertEquals(workspaceRequest, {
      operation: "write",
      target: "workspace.txt",
      risk: "medium",
      summary: "write 9 bytes",
      sessionId: "test-session",
      turnId: "test-turn",
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    });

    const hostRequest = (await ctx.fs.operation({
      operation: "read",
      path: `${outside}/host.txt`,
      access: "read",
      summary: "read text",
    })).approvalRequest();
    assertEquals(hostRequest.target, path.resolve(`${outside}/host.txt`));
    assertEquals(hostRequest.risk, "high");
    assertEquals(hostRequest.timeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS * 2);
  } finally {
    await cleanup();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("ToolFilesystem require validates file, directory, file-or-directory, missing, and other", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/file.txt`, "file");
    await Deno.mkdir(`${dir}/dir`);
    await Deno.writeTextFile(`${dir}/target.txt`, "target");
    await Deno.symlink(`${dir}/target.txt`, `${dir}/link.txt`);

    assertEquals(
      (await ctx.fs.operation({
        operation: "read",
        path: "file.txt",
        access: "read",
        require: "existingFile",
        summary: "read text",
      })).target.kind,
      "file",
    );
    assertEquals(
      (await ctx.fs.operation({
        operation: "list",
        path: "dir",
        access: "read",
        require: "existingDirectory",
        summary: "list directory",
      })).target.kind,
      "directory",
    );
    assertEquals(
      (await ctx.fs.operation({
        operation: "grep",
        path: "file.txt",
        access: "read",
        require: "existingFileOrDirectory",
        summary: "grep",
      })).target.kind,
      "file",
    );
    assertEquals(
      (await ctx.fs.operation({
        operation: "write",
        path: "missing.txt",
        access: "write",
        require: "missing",
        summary: "write",
      })).target.kind,
      "missing",
    );

    await assertRejects(
      () =>
        ctx.fs.operation({
          operation: "read",
          path: "dir",
          access: "read",
          require: "existingFile",
          summary: "read text",
        }),
      Error,
      "Not a file",
    );

    const op = await ctx.fs.operation({
      operation: "read",
      path: "link.txt",
      access: "read",
      require: "existingFile",
      summary: "read text",
    });
    assert(op.target.absolutePath.endsWith("target.txt"));
  } finally {
    await cleanup();
  }
});

Deno.test("ToolFilesystem mutationQueue serializes same-file writes", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = await ctx.fs.operation({
      operation: "write",
      path: "queued.txt",
      access: "write",
      summary: "write first",
      mutationQueue: true,
    });
    const second = await ctx.fs.operation({
      operation: "write",
      path: "queued.txt",
      access: "write",
      summary: "write second",
      mutationQueue: true,
    });

    const firstRun = first.withAccess(async () => {
      order.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
    await firstStarted.promise;
    const secondRun = second.withAccess(async () => {
      await Promise.resolve();
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertEquals(order, ["first:start"]);

    releaseFirst.resolve();
    await Promise.all([firstRun, secondRun]);
    assertEquals(order, ["first:start", "first:end", "second"]);
  } finally {
    await cleanup();
  }
});

Deno.test("createToolContext normalizes trailing separator", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-context-" });
  try {
    const ctx = await createToolContext(`${dir}/`);
    assertEquals(ctx.root.endsWith("/"), false);
    assertEquals(await Deno.realPath(normalizeRoot(`${dir}/`)), ctx.root);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ToolFilesystem displayPath relativizes workspace paths", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    assertEquals(ctx.fs.displayPath(`${ctx.root}/nested/file.txt`), "nested/file.txt");
    assertStringIncludes(ctx.fs.displayPath("/not-in-workspace/file.txt"), "/not-in-workspace/file.txt");
  } finally {
    await cleanup();
  }
});
