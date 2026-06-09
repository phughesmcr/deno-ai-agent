import { type EgressOutbox, type EventStore, listPendingCapabilities, type WorkQueue } from "../core/mod.ts";
import { isTerminalWorkStatus } from "../core/work-state.ts";
import { telegramTargetForWork } from "./work-payload.ts";

/** Result of recovering durable capability requests left pending across restart. */
export interface RecoverTelegramPendingCapabilitiesResult {
  /** Pending capabilities found in the event log. */
  pending: number;
  /** Capabilities converted into durable interrupted-denial events. */
  recovered: number;
  /** Capabilities that did not have enough work/target data to recover. */
  skipped: number;
  /** Telegram notices queued through the durable egress outbox. */
  notified: number;
  /** Work items cancelled because they were still non-terminal. */
  cancelledWorkIds: string[];
}

/** Options for recovering pending Telegram capability prompts on host startup. */
export interface RecoverTelegramPendingCapabilitiesOptions {
  /** Durable event store. */
  events: EventStore;
  /** Durable work queue. */
  queue: WorkQueue;
  /** Durable Telegram egress outbox. */
  outbox: EgressOutbox;
  /** Deterministic clock for tests. */
  now?: () => Date;
}

const RECOVERY_NOTICE =
  "Silas restarted while waiting for approval. I cancelled that interrupted turn; please send the request again if you still need it.";

/** Recovers orphaned Telegram capability prompts whose in-memory callback waiter was lost on restart. */
export async function recoverTelegramPendingCapabilities(
  options: RecoverTelegramPendingCapabilitiesOptions,
): Promise<RecoverTelegramPendingCapabilitiesResult> {
  const now = options.now ?? (() => new Date());
  const pending = await listPendingCapabilities(options.events);
  const result: RecoverTelegramPendingCapabilitiesResult = {
    pending: pending.length,
    recovered: 0,
    skipped: 0,
    notified: 0,
    cancelledWorkIds: [],
  };

  for (const capability of pending) {
    if (!capability.workId) {
      result.skipped++;
      continue;
    }
    const work = await options.queue.get(capability.workId);
    if (!work) {
      result.skipped++;
      continue;
    }
    const target = telegramTargetForWork(work);
    if (!target) {
      result.skipped++;
      continue;
    }

    await options.outbox.queue({
      workId: work.id,
      sessionId: capability.sessionId ?? work.sessionId,
      target,
      replies: [],
      fallbackText: RECOVERY_NOTICE,
      egressId: `capability-recovered:${capability.key}`,
      now: now(),
    });
    result.notified++;

    if (!isTerminalWorkStatus(work.status)) {
      await options.queue.cancel(work.id, {
        reason: "pending approval interrupted by restart",
        now: now(),
      });
      result.cancelledWorkIds.push(work.id);
    }

    await options.events.append({
      category: "approval.decided",
      workId: capability.workId,
      sessionId: capability.sessionId ?? work.sessionId,
      payload: {
        capability: capability.capability,
        decision: "deny",
        scope: "once",
        reason: "pending approval interrupted by restart",
        source: "startup-recovery",
        decidedAt: now().toISOString(),
      },
    });
    result.recovered++;
  }

  return result;
}
