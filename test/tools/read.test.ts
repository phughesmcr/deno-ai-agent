import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";

import { createDenyApprovalGate } from "../../src/shared/approval.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
import { createReadTool } from "../../src/agent/tools/read.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

Deno.test("read returns file content", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/a.txt`, "hello\nworld");
    const tool = createReadTool(ctx);
    const out = await runToolImplementation(tool, { path: "a.txt" });
    assertStringIncludes(out, "hello");
    assertStringIncludes(out, "world");
  } finally {
    await cleanup();
  }
});

Deno.test("read requests approval before returning file content", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-tools-" });
  try {
    await Deno.writeTextFile(`${dir}/secret.txt`, "secret");
    const ctx = await createToolContext(dir, {
      approvalGate: createDenyApprovalGate("read denied"),
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const tool = createReadTool(ctx);

    await assertRejects(
      () => runToolImplementation(tool, { path: "secret.txt" }),
      Error,
      "read denied",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("read returns host file outside workspace when given an absolute path", async () => {
  const outside = await Deno.makeTempDir({ prefix: "silas-outside-" });
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const file = `${outside}/codex.toml`;
    await Deno.writeTextFile(file, "model = test\n");
    const tool = createReadTool(ctx);
    const out = await runToolImplementation(tool, { path: file });
    assertStringIncludes(out, "model = test");
    assertEquals(dir !== outside, true);
  } finally {
    await cleanup();
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("read supports offset and limit", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/lines.txt`, "one\ntwo\nthree\nfour");
    const tool = createReadTool(ctx);
    const out = await runToolImplementation(tool, { path: "lines.txt", offset: 2, limit: 2 });
    assertEquals(out.includes("two"), true);
    assertEquals(out.includes("three"), true);
    assertEquals(out.includes("one"), false);
  } finally {
    await cleanup();
  }
});
