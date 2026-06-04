import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createTypeScriptReplTool } from "../../src/agent/tools/typescript-repl.ts";
import { createTestWorkspace, runToolImplementation, runToolImplementationThrows } from "./helpers.ts";

Deno.test("typescript-repl runs TypeScript in the workspace", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createTypeScriptReplTool(ctx);
    const out = await runToolImplementation(tool, {
      typescript: `
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

Deno.test("typescript-repl throws on non-zero exit", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createTypeScriptReplTool(ctx);
    const err = await runToolImplementationThrows(tool, {
      typescript: `console.error("bad"); Deno.exit(7);`,
    });
    assertStringIncludes(err.message, "bad");
    assertStringIncludes(err.message, "TypeScript exited with code 7");
  } finally {
    await cleanup();
  }
});

Deno.test("typescript-repl times out", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createTypeScriptReplTool(ctx);
    const err = await runToolImplementationThrows(tool, {
      typescript: `await new Promise((resolve) => setTimeout(resolve, 10_000));`,
      timeout: 0.1,
    });
    assertStringIncludes(err.message, "TypeScript execution timed out");
  } finally {
    await cleanup();
  }
});
