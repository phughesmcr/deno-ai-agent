import { type Chat, ChatMessage, type LLM, type Tool } from "@lmstudio/sdk";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createAutoApprovalGate } from "../../src/approval.ts";
import { createSkillManager } from "../../src/skills/mod.ts";
import { createReadOnlySubagentTools, SubagentManager, type SubagentRecord } from "../../src/subagents.ts";
import { type AgentAction, createAgentTool } from "../../src/tools/agent.ts";
import { createToolContext, type ToolContext } from "../../src/tools/context.ts";
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

type AgentToolJson =
  | { ok: true; action: AgentAction; agent: SubagentRecord }
  | { ok: true; action: "list"; agents: SubagentRecord[] }
  | { ok: false; action: AgentAction | string; error: string };

function parseJson(text: string): AgentToolJson {
  return JSON.parse(text) as AgentToolJson;
}

function requireAgent(response: AgentToolJson): SubagentRecord {
  if (!response.ok || !("agent" in response)) throw new Error(`Expected agent response: ${JSON.stringify(response)}`);
  return response.agent;
}

function requireAgents(response: AgentToolJson): SubagentRecord[] {
  if (!response.ok || !("agents" in response)) {
    throw new Error(`Expected agents response: ${JSON.stringify(response)}`);
  }
  return response.agents;
}

function requireError(response: AgentToolJson): string {
  if (response.ok) throw new Error(`Expected error response: ${JSON.stringify(response)}`);
  return response.error;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAgent(
  tool: unknown,
  agentId: string,
  status: SubagentRecord["status"],
  deadline = performance.now() + 1_000,
): Promise<SubagentRecord> {
  const response = parseJson(await runTool(tool, { action: "status", agent_id: agentId }));
  const agent = response.ok && "agent" in response ? response.agent : undefined;
  if (agent?.status === status) return agent;
  if (performance.now() > deadline) {
    throw new Error(`Timed out waiting for ${agentId} to become ${status}; last status was ${agent?.status}`);
  }
  await delay(5);
  return await waitForAgent(tool, agentId, status, deadline);
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
        tool: createAgentTool(manager),
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

Deno.test("agent tool validates required parameters and unknown ids", async () => {
  await withSubagents(async ({ tool }) => {
    assertEquals(
      parseJson(await runTool(tool, { action: "spawn" })),
      { ok: false, action: "spawn", error: 'Parameter "task" is required for spawn.' },
    );

    const requiredAgentIdResponses = await Promise.all(
      (["status", "result", "cancel"] as const).map(async (action) => ({
        action,
        response: parseJson(await runTool(tool, { action })),
      })),
    );
    for (const { action, response } of requiredAgentIdResponses) {
      assertEquals(
        response,
        { ok: false, action, error: 'Parameter "agent_id" is required for this action.' },
      );
    }

    const unknown = parseJson(await runTool(tool, { action: "status", agent_id: crypto.randomUUID() }));
    assertStringIncludes(requireError(unknown), "Unknown agent_id");

    const unknownAction = parseJson(await runTool(tool, { action: "pause" }));
    assertEquals(unknownAction.ok, false);
    assertEquals(unknownAction.action, "pause");
    assertStringIncludes(requireError(unknownAction), 'Parameter "action" must be one of');
  });
});

Deno.test("agent lifecycle records completed and failed jobs", async () => {
  await withSubagents(async ({ model, tool }) => {
    model.behaviors.push(model.replies(["draft", "final result"]));
    const spawned = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "Inspect the repo" })));
    assert(["queued", "running", "completed"].includes(spawned.status));
    assertEquals(spawned.task, "Inspect the repo");

    const completed = await waitForAgent(tool, spawned.id, "completed");
    assertEquals(completed.result, "final result");
    assertEquals(completed.error, undefined);

    model.behaviors.push(model.fail("model failed"));
    const failedSpawn = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "Fail clearly" })));
    const failed = await waitForAgent(tool, failedSpawn.id, "failed");
    assertStringIncludes(failed.error ?? "", "model failed");

    const resultResponse = requireAgent(parseJson(
      await runTool(tool, {
        action: "result",
        agent_id: completed.id,
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

    const first = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "First" })));
    await firstStarted.promise;
    const second = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "Second" })));

    const secondStatus = requireAgent(parseJson(await runTool(tool, { action: "status", agent_id: second.id })));
    assertEquals(secondStatus.status, "queued");

    releaseFirst.resolve();
    assertEquals((await waitForAgent(tool, first.id, "completed")).result, "first done");
    assertEquals((await waitForAgent(tool, second.id, "completed")).result, "second done");
  });
});

Deno.test("agent cancel aborts active jobs and is idempotent for terminal jobs", async () => {
  await withSubagents(async ({ model, tool }) => {
    const started = deferred<void>();
    model.behaviors.push(model.waitUntilAbort(started));
    const spawned = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "Wait" })));
    await started.promise;

    const cancelled = requireAgent(parseJson(await runTool(tool, { action: "cancel", agent_id: spawned.id })));
    assertEquals(cancelled.status, "cancelled");
    assertEquals((await waitForAgent(tool, spawned.id, "cancelled")).status, "cancelled");

    const cancelledAgain = requireAgent(parseJson(await runTool(tool, { action: "cancel", agent_id: spawned.id })));
    assertEquals(cancelledAgain.status, "cancelled");

    model.behaviors.push(model.reply("complete"));
    const completedSpawn = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "Complete" })));
    const completed = await waitForAgent(tool, completedSpawn.id, "completed");
    const completedCancel = requireAgent(parseJson(
      await runTool(tool, {
        action: "cancel",
        agent_id: completed.id,
      }),
    ));
    assertEquals(completedCancel.status, "completed");

    model.behaviors.push(model.fail("terminal failure"));
    const failedSpawn = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "Fail" })));
    const failed = await waitForAgent(tool, failedSpawn.id, "failed");
    const failedCancel = requireAgent(parseJson(await runTool(tool, { action: "cancel", agent_id: failed.id })));
    assertEquals(failedCancel.status, "failed");
  });
});

Deno.test("agent list only returns jobs for the current session", async () => {
  await withSubagents(async ({ setSessionId, tool }) => {
    const firstSessionId = crypto.randomUUID();
    const secondSessionId = crypto.randomUUID();

    setSessionId(firstSessionId);
    const first = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "Session one" })));

    setSessionId(secondSessionId);
    const second = requireAgent(parseJson(await runTool(tool, { action: "spawn", task: "Session two" })));
    const secondList = requireAgents(parseJson(await runTool(tool, { action: "list" })));
    assertEquals(secondList.map((agent) => agent.id), [second.id]);

    setSessionId(firstSessionId);
    const firstList = requireAgents(parseJson(await runTool(tool, { action: "list" })));
    assertEquals(firstList.map((agent) => agent.id), [first.id]);
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
    assertEquals(names.includes("agent"), false);
  });
});
