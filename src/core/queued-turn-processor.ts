import { errorMessage } from "../shared/error.ts";
import { isAbortError } from "../shared/abort.ts";
import type { LeasedWorkItem, WorkKind, WorkQueue } from "./work-queue.ts";
import type { WorkspaceGate } from "./workspace-gate.ts";

/** Result of one queue-processing attempt. */
export type QueuedTurnProcessorResult =
  | { status: "idle" }
  | { status: "completed"; workId: string };

/** Options passed to a leased work runner. */
export interface QueuedWorkRunnerOptions {
  /** Abort signal for the active work item. */
  signal: AbortSignal;
}

/** Minimal runner contract for one leased work item. */
export interface QueuedWorkRunner {
  /** Runs a leased work item and settles its durable queue state. */
  run(work: LeasedWorkItem, options: QueuedWorkRunnerOptions): Promise<unknown>;
}

/** Options for constructing a queued turn processor. */
export interface QueuedTurnProcessorOptions {
  /** Durable work queue. */
  queue: WorkQueue;
  /** In-process gate used to serialize workspace-visible work. */
  workspaceGate: WorkspaceGate;
  /** Runner for a leased work item. */
  runner: QueuedWorkRunner;
  /** Host/process owner id. */
  ownerId: string;
  /** Work kinds this processor may lease. Defaults to all turn-like work. */
  kinds?: readonly WorkKind[];
}

/** Options for processing one queued work item. */
export interface ProcessQueuedTurnOptions {
  /** Abort signal for the active work item. */
  signal: AbortSignal;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

const DEFAULT_KINDS: readonly WorkKind[] = ["user_turn", "cron_run", "subagent_run", "maintenance"];

/** Leases queued work and runs it through a runner under the workspace gate. */
export class QueuedTurnProcessor {
  private readonly _queue: WorkQueue;
  private readonly _workspaceGate: WorkspaceGate;
  private readonly _runner: QueuedWorkRunner;
  private readonly _ownerId: string;
  private readonly _kinds: readonly WorkKind[];

  /** Creates a queued turn processor. */
  constructor(options: QueuedTurnProcessorOptions) {
    this._queue = options.queue;
    this._workspaceGate = options.workspaceGate;
    this._runner = options.runner;
    this._ownerId = options.ownerId;
    this._kinds = options.kinds ?? DEFAULT_KINDS;
  }

  /** Processes at most one queued work item. */
  async processNext(options: ProcessQueuedTurnOptions): Promise<QueuedTurnProcessorResult> {
    const work = await this._queue.leaseNext({
      ownerId: this._ownerId,
      kinds: this._kinds,
      now: options.now,
    });
    if (!work) return { status: "idle" };

    return await this._runLeased(work, options);
  }

  /** Processes one queued work item by id. */
  async process(workId: string, options: ProcessQueuedTurnOptions): Promise<QueuedTurnProcessorResult> {
    const work = await this._queue.lease(workId, {
      ownerId: this._ownerId,
      kinds: this._kinds,
      now: options.now,
    });
    if (!work) return { status: "idle" };

    return await this._runLeased(work, options);
  }

  /** Runs already-leased work under the in-process workspace gate. */
  private async _runLeased(
    work: LeasedWorkItem,
    options: ProcessQueuedTurnOptions,
  ): Promise<QueuedTurnProcessorResult> {
    try {
      await this._workspaceGate.runExclusive(work.id, options.signal, () =>
        this._runner.run(work, {
          signal: options.signal,
        }));
      return { status: "completed", workId: work.id };
    } catch (error) {
      await this._settleStillLeasedWork(work, error, options);
      throw error;
    }
  }

  /** Fails or releases work only when the runner threw before settling the original lease. */
  private async _settleStillLeasedWork(
    work: LeasedWorkItem,
    error: unknown,
    options: ProcessQueuedTurnOptions,
  ): Promise<void> {
    const current = await this._queue.get(work.id);
    if (current?.status !== "leased" || current.lease?.id !== work.lease.id) return;

    if (isAbortError(error, options.signal)) {
      await this._queue.release(work.id, {
        leaseId: work.lease.id,
        now: options.now,
        availableAt: options.now,
      });
      return;
    }

    await this._queue.fail(work.id, {
      leaseId: work.lease.id,
      now: options.now,
      reason: errorMessage(error),
    });
  }
}
