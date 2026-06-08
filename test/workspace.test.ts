import { assert } from "jsr:@std/assert@1/assert";
import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertStringIncludes } from "jsr:@std/assert@1/string-includes";
import * as path from "@std/path";
import { createWorkspace, notifyWorkspaceSubscribers } from "../src/agent/workspace.ts";
import { setMcpSystemPromptAppendix } from "../src/agent/tools/prompt.ts";
import { withEnv } from "./_env.ts";

function withDebugLogs(fn: () => Promise<void>): Promise<string[]> {
  const previousLevel = Deno.env.get("LOG_LEVEL");
  const lines: string[] = [];
  const decoder = new TextDecoder();
  const originalWriteSync = Deno.stderr.writeSync.bind(Deno.stderr);
  Deno.stderr.writeSync = (data: Uint8Array): number => {
    lines.push(...decoder.decode(data).trimEnd().split("\n").filter((line) => line.length > 0));
    return data.length;
  };
  Deno.env.set("LOG_LEVEL", "debug");

  return fn().then(
    () => lines,
    (error) => {
      throw error;
    },
  ).finally(() => {
    Deno.stderr.writeSync = originalWriteSync;
    if (previousLevel === undefined) {
      Deno.env.delete("LOG_LEVEL");
    } else {
      Deno.env.set("LOG_LEVEL", previousLevel);
    }
  });
}

Deno.test("notifyWorkspaceSubscribers calls all subscribers and logs failures", async () => {
  const calls: string[] = [];
  const event = { kind: "modify", paths: ["/tmp/SYSTEM.md"] } as Deno.FsEvent;

  const logs = await withDebugLogs(async () => {
    await notifyWorkspaceSubscribers([
      () => {
        calls.push("first");
      },
      () => {
        calls.push("second");
        throw new Error("subscriber failed");
      },
      () => {
        calls.push("third");
      },
    ], event);
  });

  assertEquals(calls, ["first", "second", "third"]);
  assertEquals(logs.length, 1);
  const log = logs[0];
  assert(log);
  assert(log.startsWith("workspace.subscriber.error "));
  assertEquals(JSON.parse(log.replace("workspace.subscriber.error ", "")), {
    message: "subscriber failed",
  });
});

Deno.test("createWorkspace does not create the legacy sessions directory", async () => {
  const root = await Deno.makeTempDir();
  try {
    const workspacePath = path.join(root, "workspace");
    await Deno.mkdir(workspacePath, { recursive: true });
    await Deno.writeTextFile(path.join(workspacePath, "SYSTEM.md"), "system");

    await withEnv({ WORKSPACE_PATH: workspacePath }, async () => {
      const workspace = await createWorkspace(path.toFileUrl(`${root}/`));
      try {
        await assertRejectsStat(path.join(workspacePath, "sessions"));
      } finally {
        workspace[Symbol.dispose]();
      }
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("workspace systemPrompt reflects refreshed MCP appendices without rewriting SYSTEM.md", async () => {
  const root = await Deno.makeTempDir();
  try {
    const workspacePath = path.join(root, "workspace");
    await Deno.mkdir(workspacePath, { recursive: true });
    await Deno.writeTextFile(path.join(workspacePath, "SYSTEM.md"), "system");
    setMcpSystemPromptAppendix("");

    await withEnv({ WORKSPACE_PATH: workspacePath }, async () => {
      const workspace = await createWorkspace(path.toFileUrl(`${root}/`));
      try {
        assertEquals(workspace.systemPrompt.includes("MCP prompts"), false);
        setMcpSystemPromptAppendix("\n## MCP prompts (docs)\n- docs/search: Search docs\n");
        assertStringIncludes(workspace.systemPrompt, "## MCP prompts (docs)");
      } finally {
        setMcpSystemPromptAppendix("");
        workspace[Symbol.dispose]();
      }
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function assertRejectsStat(filePath: string): Promise<void> {
  try {
    await Deno.stat(filePath);
    throw new Error(`Expected path not to exist: ${filePath}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}
