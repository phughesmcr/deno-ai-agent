import { assertEquals } from "jsr:@std/assert@1";

import { createQueueWorker, type QueuedTurnProcessorResult } from "../../src/core/mod.ts";

type ProcessorStep = QueuedTurnProcessorResult | Error;

class ScriptedProcessor {
  readonly signals: AbortSignal[] = [];
  private readonly _steps: ProcessorStep[];

  constructor(steps: ProcessorStep[]) {
    this._steps = steps;
  }

  push(step: ProcessorStep): void {
    this._steps.push(step);
  }

  processNext(options: { signal: AbortSignal }): Promise<QueuedTurnProcessorResult> {
    this.signals.push(options.signal);
    const step = this._steps.shift() ?? { status: "idle" };
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(step);
  }
}

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

Deno.test("QueueWorker drains completed work until idle", async () => {
  const controller = new AbortController();
  const processor = new ScriptedProcessor([
    { status: "completed", workId: "work-1" },
    { status: "completed", workId: "work-2" },
    { status: "idle" },
  ]);
  const idle = deferred<void>();
  const results: QueuedTurnProcessorResult[] = [];
  const worker = createQueueWorker({
    processor: processor as never,
    signal: controller.signal,
    idleDelayMs: 60_000,
    onResult: (result) => {
      results.push(result);
      if (result.status === "idle") idle.resolve();
    },
  });

  const task = worker.start();
  await idle.promise;
  controller.abort();
  await task;

  assertEquals(results, [
    { status: "completed", workId: "work-1" },
    { status: "completed", workId: "work-2" },
    { status: "idle" },
  ]);
  assertEquals(processor.signals.every((signal) => signal === controller.signal), true);
});

Deno.test("QueueWorker wakes an idle poll when new work arrives", async () => {
  const controller = new AbortController();
  const processor = new ScriptedProcessor([{ status: "idle" }]);
  const sawIdle = deferred<void>();
  const sawCompleted = deferred<void>();
  const results: QueuedTurnProcessorResult[] = [];
  const worker = createQueueWorker({
    processor: processor as never,
    signal: controller.signal,
    idleDelayMs: 60_000,
    onResult: (result) => {
      results.push(result);
      if (result.status === "idle") sawIdle.resolve();
      if (result.status === "completed") sawCompleted.resolve();
    },
  });

  const task = worker.start();
  await sawIdle.promise;
  processor.push({ status: "completed", workId: "work-1" });
  worker.wake();
  await sawCompleted.promise;
  controller.abort();
  await task;

  assertEquals(results, [
    { status: "idle" },
    { status: "completed", workId: "work-1" },
  ]);
});

Deno.test("QueueWorker reports errors and continues after wake", async () => {
  const controller = new AbortController();
  const processor = new ScriptedProcessor([new Error("boom")]);
  const sawError = deferred<void>();
  const sawCompleted = deferred<void>();
  const errors: string[] = [];
  const results: QueuedTurnProcessorResult[] = [];
  const worker = createQueueWorker({
    processor: processor as never,
    signal: controller.signal,
    errorDelayMs: 60_000,
    onError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
      sawError.resolve();
    },
    onResult: (result) => {
      results.push(result);
      if (result.status === "completed") sawCompleted.resolve();
    },
  });

  const task = worker.start();
  await sawError.promise;
  processor.push({ status: "completed", workId: "work-1" });
  worker.wake();
  await sawCompleted.promise;
  controller.abort();
  await task;

  assertEquals(errors, ["boom"]);
  assertEquals(results, [{ status: "completed", workId: "work-1" }]);
});
