import { assertStringIncludes } from "jsr:@std/assert@1";

import { createToolContext } from "../../src/agent/tools/context.ts";
import { createBashTool } from "../../src/agent/tools/bash.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

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

Deno.test("bash returns recoverable error text on non-zero exit", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createBashTool(ctx);
    const result = await runToolImplementation(tool, { command: "exit 1" });
    assertStringIncludes(result, "exited with code 1");
  } finally {
    await cleanup();
  }
});

Deno.test("bash aborts when the turn signal aborts", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-tools-" });
  const controller = new AbortController();
  try {
    const ctx = await createToolContext(dir, {
      sessionId: "session-1",
      turnId: "turn-1",
      signal: controller.signal,
    });
    const tool = createBashTool(ctx);

    const pending = runToolImplementation(tool, { command: "sleep 10" });
    setTimeout(() => controller.abort(), 25);

    const result = await pending;
    assertStringIncludes(result, "Command aborted");
  } finally {
    controller.abort();
    await Deno.remove(dir, { recursive: true });
  }
});
