import { assert, assertStringIncludes } from "jsr:@std/assert@1";

import { createToolContext } from "../../src/agent/tools/context.ts";
import { createBashTool } from "../../src/agent/tools/bash.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

async function waitForTextFile(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const text = await Deno.readTextFile(path);
      if (text.trim() === expected) return;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert(false, `Timed out waiting for ${path}`);
}

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

Deno.test("bash starts background command and returns immediately", async () => {
  const { ctx, cleanup, dir } = await createTestWorkspace();
  try {
    const tool = createBashTool(ctx);
    const started = performance.now();
    const out = await runToolImplementation(tool, {
      command: "sleep 0.2; echo done > background.txt",
      is_background: true,
    });
    assertStringIncludes(out, "Started background command with PID ");
    assert(performance.now() - started < 150, "background command should return before sleep finishes");
    await waitForTextFile(`${dir}/background.txt`, "done");
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
