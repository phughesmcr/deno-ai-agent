import { assert } from "jsr:@std/assert@1/assert";
import { assertEquals } from "jsr:@std/assert@1/equals";
import { notifyWorkspaceSubscribers } from "../src/agent/workspace.ts";

function withDebugLogs(fn: () => Promise<void>): Promise<string[]> {
  const previousLevel = Deno.env.get("LOG_LEVEL");
  const lines: string[] = [];
  // deno-lint-ignore no-console
  const originalError = console.error;
  // deno-lint-ignore no-console
  console.error = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  Deno.env.set("LOG_LEVEL", "debug");

  return fn().then(
    () => lines,
    (error) => {
      throw error;
    },
  ).finally(() => {
    // deno-lint-ignore no-console
    console.error = originalError;
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
