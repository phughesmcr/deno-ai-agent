import { assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { createBashTool } from "../../src/tools/bash.ts";
import { toolImplementation } from "./impl.ts";

Deno.test("bash runs in workspace cwd", async () => {
  const root = await Deno.makeTempDir({ prefix: "bash-tool-" });
  try {
    const run = toolImplementation<{ command: string }, string>(createBashTool({ root }));
    const out = await run({ command: "pwd" });
    assertStringIncludes(out, root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bash non-zero exit includes output", async () => {
  const root = await Deno.makeTempDir({ prefix: "bash-tool-" });
  try {
    const run = toolImplementation<{ command: string }, string>(createBashTool({ root }));
    await assertRejects(
      () => run({ command: "exit 42" }),
      Error,
      "exited with code",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
