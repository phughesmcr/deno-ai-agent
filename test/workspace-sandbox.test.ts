import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { WorkspaceSandbox } from "../src/workspace-sandbox.ts";

Deno.test("WorkspaceSandbox rejects traversal outside the root", async () => {
  const root = await Deno.makeTempDir({ prefix: "deno-ai-agent-sandbox-" });
  try {
    const sandbox = await WorkspaceSandbox.create(root);

    await assertRejects(
      () => sandbox.resolvePath("../outside.txt"),
      Error,
      "Path escapes workspace",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("WorkspaceSandbox rejects an existing symlink escape", async () => {
  const root = await Deno.makeTempDir({ prefix: "deno-ai-agent-sandbox-" });
  const outside = await Deno.makeTempDir({ prefix: "deno-ai-agent-outside-" });
  try {
    await Deno.writeTextFile(`${outside}/secret.txt`, "secret");
    await Deno.symlink(outside, `${root}/escape`);
    const sandbox = await WorkspaceSandbox.create(root);

    await assertRejects(
      () => sandbox.resolvePath("escape/secret.txt"),
      Error,
      "Path escapes workspace",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("WorkspaceSandbox rejects a missing file under a symlink escape", async () => {
  const root = await Deno.makeTempDir({ prefix: "deno-ai-agent-sandbox-" });
  const outside = await Deno.makeTempDir({ prefix: "deno-ai-agent-outside-" });
  try {
    await Deno.symlink(outside, `${root}/escape`);
    const sandbox = await WorkspaceSandbox.create(root);

    await assertRejects(
      () => sandbox.resolvePath("escape/new.txt"),
      Error,
      "Path escapes workspace",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("WorkspaceSandbox resolves a missing file below an in-workspace parent", async () => {
  const root = await Deno.makeTempDir({ prefix: "deno-ai-agent-sandbox-" });
  try {
    await Deno.mkdir(`${root}/safe`);
    const sandbox = await WorkspaceSandbox.create(root);

    const resolved = await sandbox.resolvePath("safe/new.txt");

    assertEquals(sandbox.displayPath(resolved), "safe/new.txt");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
