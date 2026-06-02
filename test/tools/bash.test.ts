import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";

import { createDenyApprovalGate } from "../../src/shared/approval.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
import { createBashTool } from "../../src/agent/tools/bash.ts";
import { createTestWorkspace, runToolImplementation, runToolImplementationThrows } from "./helpers.ts";

Deno.test("bash runs echo in workspace", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createBashTool(ctx);
    const out = await runToolImplementation(tool, { command: "echo ok" });
    assertStringIncludes(out.trim(), "ok");
  } finally {
    await cleanup();
  }
});

Deno.test("bash requests approval before spawning a command", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-tools-" });
  try {
    const ctx = await createToolContext(dir, {
      approvalGate: createDenyApprovalGate("shell denied"),
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const tool = createBashTool(ctx);

    await assertRejects(
      () => runToolImplementation(tool, { command: "printf touched > marker.txt" }),
      Error,
      "shell denied",
    );

    let exists = true;
    try {
      await Deno.stat(`${dir}/marker.txt`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) exists = false;
      else throw error;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash throws on non-zero exit", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createBashTool(ctx);
    const err = await runToolImplementationThrows(tool, { command: "exit 1" });
    assertStringIncludes(err.message, "exited with code 1");
  } finally {
    await cleanup();
  }
});
