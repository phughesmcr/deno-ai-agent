import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  KvEventStore,
  KvWorkQueue,
  type LeasedWorkItem,
  QueuedTurnProcessor,
  WorkspaceGate,
} from "../../src/core/mod.ts";

class RecordingRunner {
  readonly workIds: string[] = [];
  fail = false;

  constructor(private readonly _queue: KvWorkQueue) {}

  async run(work: LeasedWorkItem): Promise<void> {
    this.workIds.push(work.id);
    if (this.fail) {
      await this._queue.fail(work.id, {
        leaseId: work.lease.id,
        reason: "runner failed",
      });
      throw new Error("runner failed");
    }
    await this._queue.complete(work.id, { leaseId: work.lease.id });
  }
}

class UnsettledFailingRunner {
  readonly workIds: string[] = [];
  error: Error = new Error("runner crashed before settling work");

  run(work: LeasedWorkItem): Promise<void> {
    this.workIds.push(work.id);
    return Promise.reject(this.error);
  }
}

async function withKv(
  fn: (spec: { kv: Deno.Kv; events: KvEventStore; queue: KvWorkQueue }) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    const events = new KvEventStore(kv);
    await fn({ kv, events, queue: new KvWorkQueue({ kv, events }) });
  } finally {
    kv.close();
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWorkStatus(
  queue: KvWorkQueue,
  workId: string,
  status: "queued" | "leased" | "completed" | "failed" | "cancelled",
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await queue.get(workId))?.status === status) return;
    await delay(1);
  }
  assertEquals((await queue.get(workId))?.status, status);
}

function createProcessor(
  queue: KvWorkQueue,
  runner: RecordingRunner | UnsettledFailingRunner,
  gate = new WorkspaceGate(),
): QueuedTurnProcessor {
  return new QueuedTurnProcessor({
    queue,
    workspaceGate: gate,
    runner,
    ownerId: "host-a",
  });
}

Deno.test("QueuedTurnProcessor leases work, enters the workspace gate, and runs", async () => {
  await withKv(async ({ queue }) => {
    const runner = new RecordingRunner(queue);
    const processor = createProcessor(queue, runner);
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "hello" } },
    });

    const result = await processor.processNext({ signal: new AbortController().signal });

    assertEquals(result, { status: "completed", workId: work.id });
    assertEquals(runner.workIds, [work.id]);
    assertEquals((await queue.get(work.id))?.status, "completed");
  });
});

Deno.test("QueuedTurnProcessor processes a specific queued work item by id", async () => {
  await withKv(async ({ queue }) => {
    const runner = new RecordingRunner(queue);
    const processor = createProcessor(queue, runner);
    const first = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "first" } },
    });
    const second = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "second" } },
    });

    const result = await processor.process(second.id, { signal: new AbortController().signal });

    assertEquals(result, { status: "completed", workId: second.id });
    assertEquals(runner.workIds, [second.id]);
    assertEquals((await queue.get(first.id))?.status, "queued");
    assertEquals((await queue.get(second.id))?.status, "completed");
  });
});

Deno.test("QueuedTurnProcessor waits for the in-process workspace gate", async () => {
  await withKv(async ({ queue }) => {
    const runner = new RecordingRunner(queue);
    const gate = new WorkspaceGate();
    const processor = createProcessor(queue, runner, gate);
    const releaseGate = Promise.withResolvers<void>();
    const gateEntered = Promise.withResolvers<void>();
    const held = gate.runExclusive("held", new AbortController().signal, async () => {
      gateEntered.resolve();
      await releaseGate.promise;
    });
    await gateEntered.promise;

    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "hello" } },
    });
    const processing = processor.processNext({ signal: new AbortController().signal });

    try {
      await waitForWorkStatus(queue, work.id, "leased");
      assertEquals(runner.workIds, []);
    } finally {
      releaseGate.resolve();
      await held;
    }

    assertEquals(await processing, { status: "completed", workId: work.id });
    assertEquals(runner.workIds, [work.id]);
  });
});

Deno.test("QueuedTurnProcessor fails work when the runner settles it as failed", async () => {
  await withKv(async ({ queue }) => {
    const runner = new RecordingRunner(queue);
    runner.fail = true;
    const processor = createProcessor(queue, runner);
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "hello" } },
    });

    await assertRejects(
      () => processor.processNext({ signal: new AbortController().signal }),
      Error,
      "runner failed",
    );

    assertEquals((await queue.get(work.id))?.status, "failed");
  });
});

Deno.test("QueuedTurnProcessor fails work when the runner throws before settling it", async () => {
  await withKv(async ({ queue }) => {
    const runner = new UnsettledFailingRunner();
    const processor = createProcessor(queue, runner);
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "hello" } },
    });

    await assertRejects(
      () => processor.processNext({ signal: new AbortController().signal }),
      Error,
      "runner crashed before settling work",
    );

    const failed = await queue.get(work.id);
    assertEquals(failed?.status, "failed");
    assertEquals(failed?.failure, "runner crashed before settling work");
  });
});

Deno.test("QueuedTurnProcessor releases still-leased work when the runner aborts", async () => {
  await withKv(async ({ queue }) => {
    const runner = new UnsettledFailingRunner();
    runner.error = new DOMException("Shutdown", "AbortError");
    const processor = createProcessor(queue, runner);
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "hello" } },
    });
    const controller = new AbortController();
    controller.abort(runner.error);

    await assertRejects(
      () => processor.processNext({ signal: controller.signal }),
      DOMException,
      "Shutdown",
    );

    assertEquals((await queue.get(work.id))?.status, "queued");
  });
});
