import type { QueuedTurnProcessor, QueuedTurnProcessorResult } from "./queued_turn_processor.ts";

/** Callback fired after one processor attempt. */
export type QueueWorkerResultHandler = (result: QueuedTurnProcessorResult) => void | Promise<void>;

/** Callback fired when processing throws. */
export type QueueWorkerErrorHandler = (error: unknown) => void | Promise<void>;

/** Options for constructing a queue worker loop. */
export interface QueueWorkerOptions {
  /** Processor used to lease and run queued work. */
  processor: QueuedTurnProcessor;
  /** Host shutdown signal. */
  signal: AbortSignal;
  /** Delay after an idle poll. Defaults to 1000ms. */
  idleDelayMs?: number;
  /** Delay after an unexpected processing error. Defaults to idle delay. */
  errorDelayMs?: number;
  /** Optional observer for processor results. */
  onResult?: QueueWorkerResultHandler;
  /** Optional observer for thrown errors. */
  onError?: QueueWorkerErrorHandler;
}

/** Handle for a running queue worker. */
export interface QueueWorker {
  /** Starts the loop if it is not already running. */
  start(): Promise<void>;
  /** Wakes a sleeping idle loop so newly submitted work runs promptly. */
  wake(): void;
}

interface WakeWaiter {
  resolve(): void;
}

function delay(ms: number, signal: AbortSignal, waiters: Set<WakeWaiter>): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const gate = Promise.withResolvers<void>();
  const waiter: WakeWaiter = { resolve: gate.resolve };
  const timeout = setTimeout(gate.resolve, ms);
  const onAbort = (): void => {
    clearTimeout(timeout);
    gate.reject(signal.reason);
  };
  waiters.add(waiter);
  signal.addEventListener("abort", onAbort, { once: true });
  return gate.promise.finally(() => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    waiters.delete(waiter);
  });
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason || error instanceof DOMException && error.name === "AbortError");
}

/** Creates a durable queue worker loop around a {@link QueuedTurnProcessor}. */
export function createQueueWorker(options: QueueWorkerOptions): QueueWorker {
  const idleDelayMs = options.idleDelayMs ?? 1_000;
  const errorDelayMs = options.errorDelayMs ?? idleDelayMs;
  const waiters = new Set<WakeWaiter>();
  let task: Promise<void> | undefined;
  let wakePending = false;

  async function wait(ms: number): Promise<void> {
    if (wakePending) {
      wakePending = false;
      return;
    }
    await delay(ms, options.signal, waiters);
  }

  async function runLoop(): Promise<void> {
    while (!options.signal.aborted) {
      try {
        const result = await options.processor.processNext({ signal: options.signal });
        await options.onResult?.(result);
        if (result.status === "completed") continue;
        await wait(idleDelayMs);
      } catch (error) {
        if (isAbortError(error, options.signal)) return;
        await options.onError?.(error);
        await wait(errorDelayMs);
      }
    }
  }

  return {
    start(): Promise<void> {
      task ??= runLoop();
      return task;
    },
    wake(): void {
      if (waiters.size === 0) {
        wakePending = true;
        return;
      }
      for (const waiter of [...waiters]) waiter.resolve();
    },
  };
}
