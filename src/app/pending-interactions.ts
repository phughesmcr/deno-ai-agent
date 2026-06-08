import type { UserInteractionResult } from "../agent/tools/user-interaction.ts";
import {
  type EgressOutbox,
  type EventStore,
  type InteractionCompletedPayload,
  listPendingInteractions,
  type WorkQueue,
} from "../core/mod.ts";
import { isTerminalWorkStatus } from "../core/work_state.ts";
import { telegramTargetForWork } from "./work-payload.ts";

/** Result of recovering durable interaction requests left pending across restart. */
export interface RecoverTelegramPendingInteractionsResult {
  /** Pending interactions found in the event log. */
  pending: number;
  /** Interactions converted into durable cancellation completions. */
  recovered: number;
  /** Interactions that did not have enough work/target data to recover. */
  skipped: number;
  /** Telegram notices queued through the durable egress outbox. */
  notified: number;
  /** Leased work items returned to the durable queue for retry. */
  requeuedWorkIds: string[];
}

/** Options for recovering pending Telegram interactions on host startup. */
export interface RecoverTelegramPendingInteractionsOptions {
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
  "Silas restarted while waiting for your answer. I queued the interrupted turn again, so it can retry automatically.";

/** Recovers orphaned Telegram user interactions that cannot resume their lost in-memory prompt promise. */
export async function recoverTelegramPendingInteractions(
  options: RecoverTelegramPendingInteractionsOptions,
): Promise<RecoverTelegramPendingInteractionsResult> {
  const now = options.now ?? (() => new Date());
  const pending = await listPendingInteractions(options.events);
  const result: RecoverTelegramPendingInteractionsResult = {
    pending: pending.length,
    recovered: 0,
    skipped: 0,
    notified: 0,
    requeuedWorkIds: [],
  };

  for (const interaction of pending) {
    if (!interaction.workId) {
      result.skipped++;
      continue;
    }
    const work = await options.queue.get(interaction.workId);
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
      sessionId: interaction.sessionId ?? work.sessionId,
      target,
      replies: [],
      fallbackText: RECOVERY_NOTICE,
      egressId: `interaction-recovered:${interaction.interactionId}`,
      now: now(),
    });
    result.notified++;

    if (!isTerminalWorkStatus(work.status) && work.status === "leased" && work.lease) {
      await options.queue.release(work.id, {
        leaseId: work.lease.id,
        now: now(),
        availableAt: now(),
      });
      result.requeuedWorkIds.push(work.id);
    }

    await options.events.append({
      category: "interaction.completed",
      workId: interaction.workId,
      sessionId: interaction.sessionId ?? work.sessionId,
      payload: {
        interactionId: interaction.interactionId,
        status: "completed",
        result: { action: "cancel" },
        completedAt: now().toISOString(),
      } satisfies InteractionCompletedPayload<UserInteractionResult>,
    });
    result.recovered++;
  }

  return result;
}
