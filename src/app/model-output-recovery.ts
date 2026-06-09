import type { EgressOutbox, EventStore, WorkItem, WorkQueue } from "../core/mod.ts";
import { objectPayload, textFromUnknownMessage } from "../shared/mod.ts";
import type { TelegramEgressTarget } from "./telegram-egress.ts";
import { cronRunWorkPayload, userTurnWorkPayload } from "./work-payload.ts";

/** Result of recovering interrupted work with already-persisted model output. */
export interface RecoverInterruptedModelOutputsResult {
  /** Non-terminal work items with persisted model messages found in the event log. */
  candidates: number;
  /** Work items completed by this recovery pass. */
  recovered: number;
  /** Candidate work items skipped because they were unsafe to recover. */
  skipped: number;
  /** New egress records queued from persisted model messages. */
  queuedEgress: number;
  /** Work ids marked completed. */
  completedWorkIds: string[];
}

/** Options for recovering interrupted model output on startup. */
export interface RecoverInterruptedModelOutputsOptions {
  /** Durable event store. */
  events: EventStore;
  /** Durable work queue. */
  queue: WorkQueue;
  /** Durable Telegram egress outbox. */
  outbox: EgressOutbox;
  /** Owner id used to take short completion leases. */
  ownerId: string;
  /** Deterministic clock for tests. */
  now?: () => Date;
  /** Optional hook for adapter-specific side effects before recovered work is marked complete. */
  onRecoveredWork?: (work: WorkItem) => Promise<void>;
}

interface ModelOutputCandidate {
  workId: string;
  sessionId: string;
  replyTexts: string[];
  hasQueuedEgress: boolean;
}

function telegramTargetForWork(work: WorkItem): TelegramEgressTarget | undefined {
  try {
    if (work.kind === "user_turn") return userTurnWorkPayload(work.payload).telegram;
    if (work.kind === "cron_run") return cronRunWorkPayload(work.payload).telegram;
  } catch {
    return undefined;
  }
  return undefined;
}

async function interruptedModelOutputCandidates(events: EventStore): Promise<ModelOutputCandidate[]> {
  const candidates = new Map<string, ModelOutputCandidate>();
  for (const event of await events.list()) {
    if (!event.workId || !event.sessionId) continue;
    if (
      event.category === "work.completed" || event.category === "work.failed" || event.category === "work.cancelled"
    ) {
      candidates.delete(event.workId);
      continue;
    }
    if (event.category === "model.message") {
      const text = textFromUnknownMessage(objectPayload(event.payload)?.["message"]);
      if (text.length === 0) continue;
      const existing = candidates.get(event.workId);
      if (existing) {
        existing.replyTexts.push(text);
      } else {
        candidates.set(event.workId, {
          workId: event.workId,
          sessionId: event.sessionId,
          replyTexts: [text],
          hasQueuedEgress: false,
        });
      }
      continue;
    }
    if (event.category === "egress.queued") {
      const existing = candidates.get(event.workId);
      if (existing) existing.hasQueuedEgress = true;
    }
  }
  return [...candidates.values()].sort((left, right) => left.workId.localeCompare(right.workId));
}

/** Completes queued work that already persisted model output, queueing missing Telegram egress when needed. */
export async function recoverInterruptedModelOutputs(
  options: RecoverInterruptedModelOutputsOptions,
): Promise<RecoverInterruptedModelOutputsResult> {
  const now = options.now ?? (() => new Date());
  const candidates = await interruptedModelOutputCandidates(options.events);
  const result: RecoverInterruptedModelOutputsResult = {
    candidates: candidates.length,
    recovered: 0,
    skipped: 0,
    queuedEgress: 0,
    completedWorkIds: [],
  };

  for (const candidate of candidates) {
    const work = await options.queue.get(candidate.workId);
    if (!work || work.status !== "queued") {
      result.skipped++;
      continue;
    }
    const leased = await options.queue.lease(work.id, {
      ownerId: options.ownerId,
      kinds: [work.kind],
      now: now(),
    });
    if (!leased) {
      result.skipped++;
      continue;
    }

    if (!candidate.hasQueuedEgress) {
      const target = telegramTargetForWork(work);
      if (!target) {
        await options.queue.release(leased.id, {
          leaseId: leased.lease.id,
          now: now(),
        });
        result.skipped++;
        continue;
      }
      await options.outbox.queue({
        workId: work.id,
        sessionId: candidate.sessionId,
        target,
        replies: candidate.replyTexts,
        egressId: `model-output-recovered:${work.id}`,
        now: now(),
      });
      result.queuedEgress++;
    }

    await options.onRecoveredWork?.(work);
    await options.queue.complete(leased.id, {
      leaseId: leased.lease.id,
      now: now(),
    });
    result.completedWorkIds.push(work.id);
    result.recovered++;
  }

  return result;
}
