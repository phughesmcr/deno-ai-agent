import type { CronJobStore } from "../cron/mod.ts";
import type { EgressOutbox, EventStore, WorkQueue } from "../core/mod.ts";
import { errorMessage, logError, logInfo } from "../shared/mod.ts";
import { completeCronRunSchedule } from "./cron-work.ts";
import { recoverInterruptedModelOutputs } from "./model-output-recovery.ts";
import { recoverTelegramPendingCapabilities } from "./pending-approvals.ts";
import { recoverTelegramPendingInteractions } from "./pending-interactions.ts";
import {
  drainTelegramEgressOutbox,
  type DrainTelegramEgressResult,
  type TelegramEgressApi,
} from "./telegram-egress.ts";
import { cronRunWorkPayload } from "./work-payload.ts";

/** Startup recovery dependencies for one agent host process. */
export interface RunStartupRecoveryOptions {
  /** Durable event store. */
  events: EventStore;
  /** Durable work queue. */
  queue: WorkQueue;
  /** Durable egress outbox. */
  outbox: EgressOutbox;
  /** Current host owner id. */
  ownerId: string;
  /** Maximum interrupted attempts before work is failed. */
  maxInterruptedAttempts: number;
  /** Durable cron schedule store. */
  cronStore: CronJobStore;
  /** Telegram API sender used for replaying pending egress. */
  telegramApi: TelegramEgressApi;
  /** Optional shutdown signal. */
  signal?: AbortSignal;
}

/** Result of the startup recovery pass. */
export interface RunStartupRecoveryResult {
  /** Interrupted work ids requeued or failed before processing starts. */
  interruptedWork: Awaited<ReturnType<WorkQueue["recoverInterruptedWork"]>>;
  /** Persisted model outputs recovered into egress/completed work. */
  modelOutputs: Awaited<ReturnType<typeof recoverInterruptedModelOutputs>>;
  /** Pending capability turns recovered or notified. */
  approvals: Awaited<ReturnType<typeof recoverTelegramPendingCapabilities>>;
  /** Pending interaction turns recovered or notified. */
  interactions: Awaited<ReturnType<typeof recoverTelegramPendingInteractions>>;
  /** Pending Telegram egress replay result. */
  egressReplay: DrainTelegramEgressResult;
}

/** Runs all durable restart recovery before queue processing starts. */
export async function runStartupRecovery(options: RunStartupRecoveryOptions): Promise<RunStartupRecoveryResult> {
  const interruptedWork = await options.queue.recoverInterruptedWork({
    maxAttempts: options.maxInterruptedAttempts,
  });
  if (interruptedWork.requeued.length > 0 || interruptedWork.failed.length > 0) {
    logInfo(
      `Recovered interrupted work (requeued=${interruptedWork.requeued.length}, failed=${interruptedWork.failed.length}).`,
    );
  }

  const modelOutputs = await recoverInterruptedModelOutputs({
    events: options.events,
    queue: options.queue,
    outbox: options.outbox,
    ownerId: options.ownerId,
    onRecoveredWork: async (work) => {
      if (work.kind !== "cron_run") return;
      try {
        const payload = cronRunWorkPayload(work.payload);
        const job = await options.cronStore.get(payload.cron.jobId);
        if (!job) {
          logError("cron.recovered_schedule_missing_job", {
            jobId: payload.cron.jobId,
            workId: work.id,
          });
          return;
        }
        await completeCronRunSchedule(options.cronStore, job, payload);
      } catch (error) {
        logError("cron.recovered_schedule_error", {
          workId: work.id,
          message: errorMessage(error),
        });
      }
    },
  });
  if (modelOutputs.candidates > 0) {
    logInfo("Recovered interrupted model outputs.", {
      candidates: String(modelOutputs.candidates),
      recovered: String(modelOutputs.recovered),
      skipped: String(modelOutputs.skipped),
      queuedEgress: String(modelOutputs.queuedEgress),
    });
  }

  const approvals = await recoverTelegramPendingCapabilities({
    events: options.events,
    queue: options.queue,
    outbox: options.outbox,
  });
  if (approvals.pending > 0) {
    logInfo("Recovered pending Telegram capabilities.", {
      pending: String(approvals.pending),
      recovered: String(approvals.recovered),
      skipped: String(approvals.skipped),
      notified: String(approvals.notified),
    });
  }

  const interactions = await recoverTelegramPendingInteractions({
    events: options.events,
    queue: options.queue,
    outbox: options.outbox,
  });
  if (interactions.pending > 0) {
    logInfo("Recovered pending Telegram interactions.", {
      pending: String(interactions.pending),
      recovered: String(interactions.recovered),
      skipped: String(interactions.skipped),
      notified: String(interactions.notified),
    });
  }

  const egressReplay = await drainTelegramEgressOutbox({
    outbox: options.outbox,
    api: options.telegramApi,
    signal: options.signal,
  });
  if (egressReplay.pending > 0) {
    logInfo("Telegram egress replay complete.", {
      pending: String(egressReplay.pending),
      sent: String(egressReplay.sent),
      skipped: String(egressReplay.skipped),
      failed: String(egressReplay.failed),
      dropped: String(egressReplay.dropped),
    });
  }

  return {
    interruptedWork,
    modelOutputs,
    approvals,
    interactions,
    egressReplay,
  };
}
