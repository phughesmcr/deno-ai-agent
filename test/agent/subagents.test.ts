import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";

import type { SubagentActRequest, SubagentActResult } from "../../src/agent/model-act.ts";
import { createSkillManager } from "../../src/agent/skills/mod.ts";
import { SubagentRuntime } from "../../src/agent/subagents.ts";
import { createToolContext, type ToolContext } from "../../src/agent/tools/context.ts";
import {
  KvKernelStore,
  QueuedTurnProcessor,
  type QueuedTurnProcessorResult,
  WorkspaceGate,
} from "../../src/core/mod.ts";

type FakeBehavior = (request: SubagentActRequest) => Promise<SubagentActResult>;

class FakeModel {
  readonly runCalls: SubagentActRequest[] = [];
  readonly behaviors: FakeBehavior[] = [];

  runSubagent(request: SubagentActRequest): Promise<SubagentActResult> {
    this.runCalls.push(request);
    const behavior = this.behaviors.shift() ?? this.reply("default result");
    return behavior(request);
  }

  reply(text: string): FakeBehavior {
    return () => Promise.resolve({ text });
  }

  fail(message: string): FakeBehavior {
    return () => Promise.reject(new Error(message));
  }

  waitUntilAbort(started: PromiseWithResolvers<void>): FakeBehavior {
    return (request) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        const abort = (): void => reject(request.signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (request.signal.aborted) {
          abort();
          return;
        }
        request.signal.addEventListener("abort", abort, { once: true });
      });
    };
  }
}

interface RuntimeSpec {
  kv: Deno.Kv;
  ctx: ToolContext;
  events: KvKernelStore;
  queue: KvKernelStore;
  gate: WorkspaceGate;
  model: FakeModel;
  runtime: SubagentRuntime;
  processor: QueuedTurnProcessor;
  setSessionId(id: string): void;
  wakeCount(): number;
}

async function withRuntime(
  fn: (spec: RuntimeSpec) => Promise<void>,
  options: {
    createId?: () => string;
  } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-subagents-" });
  const kv = await Deno.openKv(":memory:");
  let sessionId = "session-1";
  let wakeCount = 0;
  const model = new FakeModel();
  try {
    const events = new KvKernelStore(kv);
    const queue = events;
    const gate = new WorkspaceGate();
    const ctx = await createToolContext(dir, {
      sessionId: () => sessionId,
      turnId: "subagent-test",
    });
    const skills = await createSkillManager({ root: dir });
    const runtime = new SubagentRuntime({
      events,
      queue,
      model,
      workspace: ctx,
      skills,
      getSessionId: () => sessionId,
      wakeQueue: () => {
        wakeCount++;
      },
      ...(options.createId !== undefined ? { createId: options.createId } : {}),
    });
    const processor = new QueuedTurnProcessor({
      queue,
      workspaceGate: gate,
      runner: {
        run: (work, runnerOptions) => runtime.runQueuedWork(work, runnerOptions),
      },
      ownerId: "subagent-test-host",
      kinds: ["subagent_run"],
    });
    try {
      await fn({
        kv,
        ctx,
        events,
        queue,
        gate,
        model,
        runtime,
        processor,
        setSessionId: (id) => {
          sessionId = id;
        },
        wakeCount: () => wakeCount,
      });
    } finally {
      await runtime.shutdown();
    }
  } finally {
    kv.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function processNext(
  processor: QueuedTurnProcessor,
  signal = new AbortController().signal,
): Promise<QueuedTurnProcessorResult> {
  return await processor.processNext({ signal });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorkStatus(
  queue: KvKernelStore,
  workId: string,
  status: "queued" | "leased" | "completed" | "failed" | "cancelled",
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await queue.get(workId))?.status === status) return;
    await delay(1);
  }
  assertEquals((await queue.get(workId))?.status, status);
}

Deno.test("SubagentRuntime spawn creates a record, submits subagent_run, and wakes the queue", async () => {
  await withRuntime(
    async ({ model, queue, runtime, wakeCount }) => {
      const spawned = await runtime.spawn({ task: "  Inspect repo  ", title: "  Repo check  " });

      assertEquals({ ...spawned, createdAt: "<created>" }, {
        id: "fixed-subagent-id",
        sessionId: "session-1",
        title: "Repo check",
        task: "Inspect repo",
        status: "queued",
        createdAt: "<created>",
      });
      assertEquals(Number.isNaN(Date.parse(spawned.createdAt)), false);
      assertEquals(await runtime.status(spawned.id), spawned);
      assertEquals(model.runCalls.length, 0);
      assertEquals(wakeCount(), 1);

      const work = await queue.get(spawned.id);
      assertEquals(work?.kind, "subagent_run");
      assertEquals(work?.sessionId, "session-1");
      assertEquals(work?.status, "queued");
      assertEquals(work?.payload, { task: "Inspect repo", title: "Repo check" });
    },
    {
      createId: () => "fixed-subagent-id",
    },
  );
});

Deno.test("QueuedTurnProcessor leases subagent_run work and completes the subagent", async () => {
  await withRuntime(async ({ model, processor, queue, runtime }) => {
    model.behaviors.push(model.reply("read-only result"));
    const spawned = await runtime.spawn({ task: "Inspect files" });

    assertEquals(await processNext(processor), { status: "completed", workId: spawned.id });

    const completed = await runtime.status(spawned.id);
    assertEquals(completed?.status, "completed");
    assertEquals(completed?.result, "read-only result");
    assertEquals((await queue.get(spawned.id))?.status, "completed");

    const call = model.runCalls[0];
    assert(call);
    assertStringIncludes(call.systemPrompt, "read-only research subagent");
    assertEquals(call.task, "Inspect files");
    assertEquals(call.signal.aborted, false);
    assertEquals(call.tools.map((item) => item.name).toSorted(), ["find", "grep", "ls", "read", "skill"]);
  });
});

Deno.test("SubagentRuntime records durable work and model event order", async () => {
  await withRuntime(async ({ events, processor, runtime }) => {
    const spawned = await runtime.spawn({ task: "Record durable lifecycle" });
    await processNext(processor);

    assertEquals((await events.listByWork(spawned.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "model.round.started",
      "model.message",
      "work.completed",
    ]);
  });
});

Deno.test("SubagentRuntime records durable subagent tool lifecycle events", async () => {
  await withRuntime(async ({ events, model, processor, runtime }) => {
    model.behaviors.push((request) => {
      request.observer?.onRoundStart(0);
      request.observer?.onToolCallRequestStart(0, 7, "call-read");
      request.observer?.onToolCallRequestNameReceived(7, "read");
      request.observer?.onToolCallRequestEnd(0, 7, "read", false);
      request.observer?.onToolCallRequestFinalized(7, "read");
      return Promise.resolve({ text: "read-only result" });
    });

    const spawned = await runtime.spawn({ task: "Read a file" });
    await processNext(processor);

    const durableEvents = await events.listByWork(spawned.id);
    assertEquals(durableEvents.map((event) => event.category), [
      "work.created",
      "work.leased",
      "model.round.started",
      "tool.requested",
      "tool.completed",
      "model.message",
      "work.completed",
    ]);
    assertEquals(
      durableEvents.find((event) => event.category === "model.message")?.payload,
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "read-only result" }],
        },
      },
    );
  });
});

Deno.test("SubagentRuntime marks record and work failed on model errors", async () => {
  await withRuntime(async ({ model, processor, queue, runtime }) => {
    model.behaviors.push(model.fail("model failed"));
    const spawned = await runtime.spawn({ task: "Fail clearly" });

    await assertRejects(
      () => processNext(processor),
      Error,
      "model failed",
    );

    const failed = await runtime.status(spawned.id);
    assertEquals(failed?.status, "failed");
    assertStringIncludes(failed?.error ?? "", "model failed");
    assertEquals((await queue.get(spawned.id))?.status, "failed");
  });
});

Deno.test("subagent work waits behind WorkspaceGate via the shared queue processor", async () => {
  await withRuntime(async ({ gate, model, processor, queue, runtime }) => {
    const releaseGate = Promise.withResolvers<void>();
    const gateEntered = Promise.withResolvers<void>();
    const held = gate.runExclusive("parent-turn", new AbortController().signal, async () => {
      gateEntered.resolve();
      await releaseGate.promise;
    });
    await gateEntered.promise;
    model.behaviors.push(model.reply("subagent done"));

    const spawned = await runtime.spawn({ task: "Inspect without racing writes" });
    const processing = processNext(processor);

    try {
      await waitForWorkStatus(queue, spawned.id, "leased");
      assertEquals(model.runCalls.length, 0);
      assertEquals((await runtime.status(spawned.id))?.status, "running");
    } finally {
      releaseGate.resolve();
      await held;
    }

    assertEquals(await processing, { status: "completed", workId: spawned.id });
    assertEquals((await runtime.status(spawned.id))?.result, "subagent done");
  });
});

Deno.test("queued subagent cancellation marks record and work cancelled", async () => {
  await withRuntime(async ({ processor, queue, runtime }) => {
    const spawned = await runtime.spawn({ task: "Cancel before lease" });

    const cancelled = await runtime.cancel(spawned.id);

    assertEquals(cancelled?.status, "cancelled");
    assertEquals((await queue.get(spawned.id))?.status, "cancelled");
    assertEquals(await processNext(processor), { status: "idle" });
  });
});

Deno.test("active subagent cancellation aborts execution and late completion does not overwrite cancellation", async () => {
  await withRuntime(async ({ model, processor, queue, runtime }) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    model.behaviors.push(async () => {
      started.resolve();
      await release.promise;
      return { text: "late completion" };
    });

    const spawned = await runtime.spawn({ task: "Race cancel and complete" });
    const processing = processNext(processor);
    await started.promise;

    const cancelled = await runtime.cancel(spawned.id);
    assertEquals(cancelled?.status, "cancelled");
    assertEquals((await queue.get(spawned.id))?.status, "cancelled");
    release.resolve();
    await processing;

    const final = await runtime.status(spawned.id);
    assertEquals(final?.status, "cancelled");
    assertEquals(final?.result, undefined);
    assertEquals((await queue.get(spawned.id))?.status, "cancelled");
  });
});

Deno.test("host abort releases subagent work instead of cancelling the record", async () => {
  await withRuntime(async ({ model, processor, queue, runtime }) => {
    const started = Promise.withResolvers<void>();
    model.behaviors.push(model.waitUntilAbort(started));

    const spawned = await runtime.spawn({ task: "Interrupt and resume" });
    const controller = new AbortController();
    const processing = processNext(processor, controller.signal);
    await started.promise;
    controller.abort(new DOMException("Shutdown", "AbortError"));

    await assertRejects(() => processing, DOMException, "Shutdown");
    assertEquals((await queue.get(spawned.id))?.status, "queued");
    assertEquals((await runtime.status(spawned.id))?.status, "queued");

    model.behaviors.push(model.reply("resumed"));
    await processNext(processor);
    assertEquals((await runtime.status(spawned.id))?.result, "resumed");
    assertEquals((await queue.get(spawned.id))?.status, "completed");
  });
});

Deno.test("SubagentRuntime marks pending records failed when durable work exhausted retries", async () => {
  await withRuntime(async ({ model, queue, runtime }) => {
    await queue.submit({
      id: "stale-agent",
      kind: "subagent_run",
      sessionId: "session-1",
      availableAt: new Date("2026-01-02T03:04:05.000Z"),
      payload: { task: "stale task", title: "Stale" },
    });
    const oldLease = await queue.lease("stale-agent", {
      ownerId: "old-host",
      kinds: ["subagent_run"],
      now: new Date("2026-01-02T03:04:06.000Z"),
    });
    assert(oldLease);
    await queue.recoverInterruptedWork({
      maxAttempts: 1,
      now: new Date("2026-01-02T03:04:07.000Z"),
    });

    const failed = await runtime.status("stale-agent");
    assertEquals(failed?.status, "failed");
    assertStringIncludes(failed?.error ?? "", "interrupted work attempts exhausted");
    assertEquals(model.runCalls.length, 0);
    assertEquals((await queue.get("stale-agent"))?.status, "failed");
  });
});

Deno.test("SubagentRuntime completes queued work from persisted model.message when processing resumes", async () => {
  await withRuntime(async ({ events, model, processor, queue, runtime }) => {
    await queue.submit({
      id: "output-agent",
      kind: "subagent_run",
      sessionId: "session-1",
      availableAt: new Date("2026-01-02T03:04:05.000Z"),
      payload: { task: "output task", title: "Output" },
    });
    const oldLease = await queue.lease("output-agent", {
      ownerId: "old-host",
      kinds: ["subagent_run"],
      now: new Date("2026-01-02T03:04:06.000Z"),
    });
    assert(oldLease);
    await events.append({
      category: "model.message",
      workId: "output-agent",
      sessionId: "session-1",
      payload: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "persisted result" }],
        },
      },
    });
    await queue.recoverInterruptedWork({
      maxAttempts: 3,
      now: new Date("2026-01-02T03:04:07.000Z"),
    });

    assertEquals(await processNext(processor), { status: "completed", workId: "output-agent" });
    const completed = await runtime.status("output-agent");
    assertEquals(completed?.status, "completed");
    assertEquals(completed?.result, "persisted result");
    assertEquals(model.runCalls.length, 0);
    assertEquals((await queue.get("output-agent"))?.status, "completed");
  });
});

Deno.test("SubagentRuntime list is scoped to the current session", async () => {
  await withRuntime(async ({ runtime, setSessionId }) => {
    setSessionId("session-a");
    const first = await runtime.spawn({ task: "Session one" });

    setSessionId("session-b");
    const second = await runtime.spawn({ task: "Session two" });
    assertEquals((await runtime.list()).map((record) => record.id), [second.id]);

    setSessionId("session-a");
    assertEquals((await runtime.list()).map((record) => record.id), [first.id]);
  });
});

Deno.test("SubagentRuntime status and result return the same stored record", async () => {
  await withRuntime(async ({ processor, runtime }) => {
    const spawned = await runtime.spawn({ task: "Inspect shared read path" });
    await processNext(processor);

    assertEquals(await runtime.status(spawned.id), await runtime.result(spawned.id));
  });
});
