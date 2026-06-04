import { assert } from "jsr:@std/assert@1/assert";
import { assertEquals } from "jsr:@std/assert@1/equals";
import { notifyWorkspaceSubscribers } from "../src/agent/workspace.ts";

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
