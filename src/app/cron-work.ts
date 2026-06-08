import type { ChatMessageData } from "@lmstudio/sdk";

import { type CronJob, type CronJobStore, nextRunForSchedule } from "../cron/mod.ts";
import type { CapabilityLedger, WorkItem, WorkQueue } from "../core/mod.ts";
import type { TelegramEgressTarget } from "./telegram-egress.ts";
import type { CronRunWorkPayload } from "./work-payload.ts";

/** Result of submitting or observing a deterministic cron work item. */
export type CronRunWorkSubmission =
  | { status: "submitted"; workId: string }
  | { status: "completed"; workId: string }
  | { status: "failed"; workId: string; reason: string };

/** Input for creating durable cron work from a leased cron job. */
export interface SubmitCronRunWorkOptions {
  /** Durable work queue. */
  queue: WorkQueue;
  /** Leased cron job being dispatched. */
  job: CronJob;
  /** Session id selected for this cron run. */
  sessionId: string;
  /** Telegram message id the model reply should thread under. */
  replyToMessageId?: number;
  /** Time at which the dispatcher submitted the run. */
  dispatchedAt: Date;
  /** Optional durable capability ledger for recording the cron profile selected for this run. */
  capabilityLedger?: Pick<CapabilityLedger, "recordDecision">;
}

/** Stable cron work id used to make dispatcher retries idempotent. */
export function cronRunWorkId(job: Pick<CronJob, "id" | "nextRunAt">): string {
  return `cron:${job.id}:${job.nextRunAt}`;
}

function telegramTarget(job: CronJob, replyToMessageId: number | undefined): TelegramEgressTarget {
  return {
    chatId: job.chatId,
    ...(job.threadId !== undefined ? { threadId: job.threadId } : {}),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    cronJobId: job.id,
  };
}

/** Converts an existing deterministic cron work item into a dispatcher-visible status. */
export function cronRunWorkSubmissionForItem(work: WorkItem): CronRunWorkSubmission {
  if (work.status === "completed") return { status: "completed", workId: work.id };
  if (work.status === "failed" || work.status === "cancelled") {
    return {
      status: "failed",
      workId: work.id,
      reason: work.failure ?? `Cron work was ${work.status}`,
    };
  }
  return { status: "submitted", workId: work.id };
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("already exists");
}

function cronUserMessage(prompt: string): ChatMessageData {
  return {
    role: "user",
    content: [{ type: "text", text: prompt }],
  } as ChatMessageData;
}

async function recordCronProfileDecision(
  options: SubmitCronRunWorkOptions,
  workId: string,
): Promise<void> {
  await options.capabilityLedger?.recordDecision({
    workId,
    sessionId: options.sessionId,
    capability: { kind: "cron_profile", target: options.job.id, action: "run" },
    decision: "allow",
    scope: "profile",
    reason: "cron profile selected for scheduled run",
    decidedBy: `cron:${options.job.id}`,
    source: "policy",
  });
}

/** Creates idempotent durable `cron_run` work for one scheduled cron execution. */
export async function submitCronRunWork(options: SubmitCronRunWorkOptions): Promise<CronRunWorkSubmission> {
  const workId = cronRunWorkId(options.job);
  const existing = await options.queue.get(workId);
  if (existing) return cronRunWorkSubmissionForItem(existing);

  try {
    const work = await options.queue.submit({
      id: workId,
      kind: "cron_run",
      sessionId: options.sessionId,
      payload: {
        input: { message: cronUserMessage(options.job.prompt) },
        prompt: options.job.prompt,
        cron: {
          jobId: options.job.id,
          ...(options.job.topicName !== undefined ? { topicName: options.job.topicName } : {}),
          sessionMode: options.job.sessionMode,
          dueAt: options.job.nextRunAt,
          dispatchedAt: options.dispatchedAt.toISOString(),
        },
        telegram: telegramTarget(options.job, options.replyToMessageId),
      },
    });
    await recordCronProfileDecision(options, work.id);
    return { status: "submitted", workId: work.id };
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const raced = await options.queue.get(workId);
    if (!raced) throw error;
    return cronRunWorkSubmissionForItem(raced);
  }
}

/** Marks a queued cron run successful and advances or removes its durable schedule. */
export async function completeCronRunSchedule(
  store: CronJobStore,
  job: CronJob,
  payload: CronRunWorkPayload,
): Promise<void> {
  const dispatchedAt = new Date(payload.cron.dispatchedAt);
  const nextRunAt = nextRunForSchedule(job.schedule, dispatchedAt);
  if (nextRunAt) {
    await store.completeRun(job.id, {
      ranAt: payload.cron.dispatchedAt,
      nextRunAt,
    });
    return;
  }
  await store.completeOneShotRun(job.id, { ranAt: payload.cron.dispatchedAt });
}

/** Marks a queued cron run failed and advances or disables its durable schedule. */
export async function failCronRunSchedule(
  store: CronJobStore,
  job: CronJob,
  payload: CronRunWorkPayload,
  error: string,
): Promise<void> {
  const dispatchedAt = new Date(payload.cron.dispatchedAt);
  const nextRunAt = nextRunForSchedule(job.schedule, dispatchedAt);
  if (nextRunAt) {
    await store.failRun(job.id, {
      failedAt: payload.cron.dispatchedAt,
      nextRunAt,
      error,
    });
    return;
  }
  await store.failOneShotRun(job.id, {
    failedAt: payload.cron.dispatchedAt,
    error,
  });
}
