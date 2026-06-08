import type { LeasedWorkItem, WorkQueue } from "../core/mod.ts";

/** Options for settling a durable maintenance work item. */
export interface RunQueuedMaintenanceWorkOptions {
  /** Durable queue that owns the leased work item. */
  queue: WorkQueue;
  /** Leased maintenance work item. */
  work: LeasedWorkItem;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Completes currently no-op maintenance work so it cannot wedge the host queue. */
export async function runQueuedMaintenanceWork(options: RunQueuedMaintenanceWorkOptions): Promise<void> {
  if (options.work.kind !== "maintenance") {
    throw new Error(`Expected maintenance work, got ${options.work.kind}`);
  }
  await options.queue.complete(options.work.id, {
    leaseId: options.work.lease.id,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
