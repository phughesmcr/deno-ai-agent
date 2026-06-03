import { type Chat, ChatMessage, type LLM, type Tool } from "@lmstudio/sdk";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createAutoApprovalGate } from "../../src/shared/approval.ts";
import { createSkillManager } from "../../src/agent/skills/mod.ts";
import { createReadOnlySubagentTools, SubagentManager, type SubagentRecord } from "../../src/agent/subagents.ts";
import { createSubagentTool, type SubagentAction } from "../../src/agent/tools/subagent.ts";
import { createToolContext, type ToolContext } from "../../src/agent/tools/context.ts";
import { runTool } from "./helpers.ts";

interface FakeActOptions {
  onMessage?: (message: ChatMessage) => void;
  signal?: AbortSignal;
}

interface FakeActCall {
  chat: Chat;
  tools: Tool[];
}

type FakeBehavior = (chat: Chat, tools: Tool[], options: FakeActOptions) => Promise<void>;

class FakeModel {
  readonly actCalls: FakeActCall[] = [];
  readonly behaviors: FakeBehavior[] = [];

  act(chat: Chat, tools: Tool[], options: FakeActOptions): Promise<void> {
    this.actCalls.push({ chat, tools });
    const behavior = this.behaviors.shift() ?? this.reply("default result");
    return behavior(chat, tools, options);
  }

  reply(text: string): FakeBehavior {
    return (_chat, _tools, options) => {
      options.onMessage?.(ChatMessage.create("assistant", text));
      return Promise.resolve();
    };
  }

  replies(texts: string[]): FakeBehavior {
    return (_chat, _tools, options) => {
      for (const text of texts) {
        options.onMessage?.(ChatMessage.create("assistant", text));
      }
      return Promise.resolve();
    };
  }

  fail(message: string): FakeBehavior {
    return () => Promise.reject(new Error(message));
  }

  waitUntilAbort(started: PromiseResolver<void>): FakeBehavior {
    return (_chat, _tools, options) => {
      started.resolve();
      return new Promise((resolve, reject) => {
        const abort = (): void => reject(new DOMException("Aborted", "AbortError"));
        if (options.signal?.aborted) abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    };
  }
}

interface PromiseResolver<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): PromiseResolver<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type SubagentToolJson =
  | { ok: true; action: SubagentAction; subagent: SubagentRecord }
  | { ok: true; action: "list"; subagents: SubagentRecord[] }
  | { ok: false; action: SubagentAction | string; error: string };

function parseJson(text: string): SubagentToolJson {
  return JSON.parse(text) as SubagentToolJson;
}

function requireSubagent(response: SubagentToolJson): SubagentRecord {
  if (!response.ok || !("subagent" in response)) {
    throw new Error(`Expected subagent response: ${JSON.stringify(response)}`);
  }
  return response.subagent;
}

function requireSubagents(response: SubagentToolJson): SubagentRecord[] {
  if (!response.ok || !("subagents" in response)) {
    throw new Error(`Expected subagents response: ${JSON.stringify(response)}`);
  }
  return response.subagents;
}

function requireError(response: SubagentToolJson): string {
  if (response.ok) throw new Error(`Expected error response: ${JSON.stringify(response)}`);
  return response.error;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSubagent(
  tool: unknown,
  subagentId: string,
  status: SubagentRecord["status"],
  deadline = performance.now() + 1_000,
): Promise<SubagentRecord> {
  const response = parseJson(await runTool(tool, { action: "status", subagent_id: subagentId }));
  const subagent = response.ok && "subagent" in response ? response.subagent : undefined;
  if (subagent?.status === status) return subagent;
  if (performance.now() > deadline) {
    throw new Error(`Timed out waiting for ${subagentId} to become ${status}; last status was ${subagent?.status}`);
  }
  await delay(5);
  return await waitForSubagent(tool, subagentId, status, deadline);
}

async function withSubagents(
  fn: (spec: {
    ctx: ToolContext;
    model: FakeModel;
    manager: SubagentManager;
    tool: unknown;
    setSessionId: (id: string) => void;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-subagents-" });
  const kv = await Deno.openKv(":memory:");
  let sessionId: string = crypto.randomUUID();
  const model = new FakeModel();
  try {
    const ctx = await createToolContext(dir, {
      approvalGate: createAutoApprovalGate("test"),
      sessionId: () => sessionId,
      turnId: "subagent-test",
    });
    const skills = await createSkillManager({ root: dir });
    const manager = new SubagentManager({
      kv,
      model: model as unknown as LLM,
      workspace: ctx,
      skills,
      getSessionId: () => sessionId,
    });
    try {
      await fn({
        ctx,
        model,
        manager,
        tool: createSubagentTool(manager),
        setSessionId: (id) => {
          sessionId = id;
        },
      });
    } finally {
      await manager.shutdown();
    }
  } finally {
    kv.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("subagent tool validates required parameters and unknown ids", async () => {
  await withSubagents(async ({ tool }) => {
    assertEquals(
      parseJson(await runTool(tool, { action: "spawn" })),
      { ok: false, action: "spawn", error: 'Parameter "task" is required for spawn.' },
    );

    const requiredSubagentIdResponses = await Promise.all(
      (["status", "result", "cancel"] as const).map(async (action) => ({
        action,
        response: parseJson(await runTool(tool, { action })),
      })),
    );
    for (const { action, response } of requiredSubagentIdResponses) {
      assertEquals(
        response,
        { ok: false, action, error: 'Parameter "subagent_id" is required for this action.' },
      );
    }

    const unknown = parseJson(await runTool(tool, { action: "status", subagent_id: crypto.randomUUID() }));
    assertStringIncludes(requireError(unknown), "Unknown subagent_id");

    const unknownAction = parseJson(await runTool(tool, { action: "pause" }));
    assertEquals(unknownAction.ok, false);
    assertEquals(unknownAction.action, "pause");
    assertStringIncludes(requireError(unknownAction), 'Parameter "action" must be one of');
  });
});

Deno.test("subagent lifecycle records completed and failed jobs", async () => {
  await withSubagents(async ({ model, tool }) => {
    model.behaviors.push(model.replies(["draft", "final result"]));
    const spawned = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "Inspect the repo" })));
    assert(["queued", "running", "completed"].includes(spawned.status));
    assertEquals(spawned.task, "Inspect the repo");

    const completed = await waitForSubagent(tool, spawned.id, "completed");
    assertEquals(completed.result, "final result");
    assertEquals(completed.error, undefined);

    model.behaviors.push(model.fail("model failed"));
    const failedSpawn = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "Fail clearly" })));
    const failed = await waitForSubagent(tool, failedSpawn.id, "failed");
    assertStringIncludes(failed.error ?? "", "model failed");

    const resultResponse = requireSubagent(parseJson(
      await runTool(tool, {
        action: "result",
        subagent_id: completed.id,
      }),
    ));
    assertEquals(resultResponse.result, "final result");
  });
});

Deno.test("SubagentManager runs one job at a time and leaves later jobs queued", async () => {
  await withSubagents(async ({ model, tool }) => {
    const releaseFirst = deferred<void>();
    const firstStarted = deferred<void>();
    model.behaviors.push(async (_chat, _tools, options) => {
      firstStarted.resolve();
      await releaseFirst.promise;
      options.onMessage?.(ChatMessage.create("assistant", "first done"));
    });
    model.behaviors.push(model.reply("second done"));

    const first = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "First" })));
    await firstStarted.promise;
    const second = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "Second" })));

    const secondStatus = requireSubagent(parseJson(await runTool(tool, { action: "status", subagent_id: second.id })));
    assertEquals(secondStatus.status, "queued");

    releaseFirst.resolve();
    assertEquals((await waitForSubagent(tool, first.id, "completed")).result, "first done");
    assertEquals((await waitForSubagent(tool, second.id, "completed")).result, "second done");
  });
});

Deno.test("subagent cancel aborts active jobs and is idempotent for terminal jobs", async () => {
  await withSubagents(async ({ model, tool }) => {
    const started = deferred<void>();
    model.behaviors.push(model.waitUntilAbort(started));
    const spawned = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "Wait" })));
    await started.promise;

    const cancelled = requireSubagent(parseJson(await runTool(tool, { action: "cancel", subagent_id: spawned.id })));
    assertEquals(cancelled.status, "cancelled");
    assertEquals((await waitForSubagent(tool, spawned.id, "cancelled")).status, "cancelled");

    const cancelledAgain = requireSubagent(
      parseJson(await runTool(tool, { action: "cancel", subagent_id: spawned.id })),
    );
    assertEquals(cancelledAgain.status, "cancelled");

    model.behaviors.push(model.reply("complete"));
    const completedSpawn = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "Complete" })));
    const completed = await waitForSubagent(tool, completedSpawn.id, "completed");
    const completedCancel = requireSubagent(parseJson(
      await runTool(tool, {
        action: "cancel",
        subagent_id: completed.id,
      }),
    ));
    assertEquals(completedCancel.status, "completed");

    model.behaviors.push(model.fail("terminal failure"));
    const failedSpawn = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "Fail" })));
    const failed = await waitForSubagent(tool, failedSpawn.id, "failed");
    const failedCancel = requireSubagent(parseJson(await runTool(tool, { action: "cancel", subagent_id: failed.id })));
    assertEquals(failedCancel.status, "failed");
  });
});

Deno.test("subagent list only returns jobs for the current session", async () => {
  await withSubagents(async ({ setSessionId, tool }) => {
    const firstSessionId = crypto.randomUUID();
    const secondSessionId = crypto.randomUUID();

    setSessionId(firstSessionId);
    const first = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "Session one" })));

    setSessionId(secondSessionId);
    const second = requireSubagent(parseJson(await runTool(tool, { action: "spawn", task: "Session two" })));
    const secondList = requireSubagents(parseJson(await runTool(tool, { action: "list" })));
    assertEquals(secondList.map((subagent) => subagent.id), [second.id]);

    setSessionId(firstSessionId);
    const firstList = requireSubagents(parseJson(await runTool(tool, { action: "list" })));
    assertEquals(firstList.map((subagent) => subagent.id), [first.id]);
  });
});

Deno.test("createReadOnlySubagentTools exposes only read-only child tools", async () => {
  await withSubagents(async ({ ctx }) => {
    const skills = await createSkillManager({ root: ctx.root });
    const tools = createReadOnlySubagentTools(ctx, skills) as Array<{ name: string }>;
    const names = tools.map((item) => item.name).toSorted();

    assertEquals(names, ["find", "grep", "ls", "read", "skill"]);
    assertEquals(names.includes("write"), false);
    assertEquals(names.includes("edit"), false);
    assertEquals(names.includes("bash"), false);
    assertEquals(names.includes("todo_write"), false);
    assertEquals(names.includes("ask_user_question"), false);
    assertEquals(names.includes("subagent"), false);
  });
});
