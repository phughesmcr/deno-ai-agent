import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";

import { createDenyApprovalGate } from "../../src/shared/approval.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
import { createDenoReplTool } from "../../src/agent/tools/deno-repl.ts";
import { createTestWorkspace, runToolImplementation, runToolImplementationThrows } from "./helpers.ts";

Deno.test("deno_repl runs JavaScript in the workspace", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createDenoReplTool(ctx);
    const out = await runToolImplementation(tool, {
      javascript: `
        await Deno.writeTextFile("out.txt", "ok");
        console.log(await Deno.readTextFile("out.txt"));
      `,
    });

    assertEquals(out.trim(), "ok");
    assertEquals(await Deno.readTextFile(`${dir}/out.txt`), "ok");
  } finally {
    await cleanup();
  }
});

Deno.test("deno_repl requests approval before creating temp files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-tools-" });
  try {
    const ctx = await createToolContext(dir, {
      approvalGate: createDenyApprovalGate("deno repl denied"),
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const tool = createDenoReplTool(ctx);

    await assertRejects(
      () => runToolImplementation(tool, { javascript: `await Deno.writeTextFile("marker.txt", "touched");` }),
      Error,
      "deno repl denied",
    );

    const entries: string[] = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("deno_repl throws on non-zero exit", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createDenoReplTool(ctx);
    const err = await runToolImplementationThrows(tool, {
      javascript: `console.error("bad"); Deno.exit(7);`,
    });
    assertStringIncludes(err.message, "bad");
    assertStringIncludes(err.message, "JavaScript exited with code 7");
  } finally {
    await cleanup();
  }
});

Deno.test("deno_repl times out", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createDenoReplTool(ctx);
    const err = await runToolImplementationThrows(tool, {
      javascript: `await new Promise((resolve) => setTimeout(resolve, 10_000));`,
      timeout: 0.1,
    });
    assertStringIncludes(err.message, "JavaScript execution timed out");
  } finally {
    await cleanup();
  }
});
