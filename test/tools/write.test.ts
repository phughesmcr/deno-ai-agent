import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { createDenyApprovalGate } from "../../src/shared/approval.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
import { createWriteTool } from "../../src/agent/tools/write.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

Deno.test("write creates nested file", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createWriteTool(ctx);
    const msg = await runToolImplementation(tool, { path: "nested/out.txt", content: "data" });
    assertEquals(msg.includes("Successfully wrote"), true);
    const text = await Deno.readTextFile(`${dir}/nested/out.txt`);
    assertEquals(text, "data");
  } finally {
    await cleanup();
  }
});

Deno.test("write requests approval before creating a file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-tools-" });
  try {
    const ctx = await createToolContext(dir, {
      approvalGate: createDenyApprovalGate("write denied"),
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const tool = createWriteTool(ctx);

    await assertRejects(
      () => runToolImplementation(tool, { path: "new.txt", content: "data" }),
      Error,
      "write denied",
    );

    let exists = true;
    try {
      await Deno.stat(`${dir}/new.txt`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) exists = false;
      else throw error;
    }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("write overwrites existing file", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await Deno.writeTextFile(`${dir}/x.txt`, "old");
    const tool = createWriteTool(ctx);
    await runToolImplementation(tool, { path: "x.txt", content: "new" });
    assertEquals(await Deno.readTextFile(`${dir}/x.txt`), "new");
  } finally {
    await cleanup();
  }
});
