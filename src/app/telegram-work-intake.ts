import { normalizeUserTurnInput, type UserTurnInput, userTurnMessageData } from "../agent/user-turn.ts";
import type { CronJob, CronJobRunnerResult, CronJobStore } from "../cron/mod.ts";
import type { CapabilityLedger, EgressOutbox, EventStore, WorkQueue } from "../core/mod.ts";
import { errorMessage, logError } from "../shared/mod.ts";
import { telegramConversationRef } from "../telegram/conversation.ts";
import type { TelegramSessionCoordinator } from "../telegram/session-coordinator.ts";
import type { TelegramContext } from "../telegram/telegram.ts";
import { cronRunWorkId, cronRunWorkSubmissionForItem, submitCronRunWork } from "./cron-work.ts";
import type { QueuedImageStore as ImageStore } from "./image-store.ts";
import {
  cancelQueuedTelegramUserTurns,
  type CancelQueuedTelegramUserTurnsResult,
  type TelegramQueuedTurnCancelTarget,
} from "./queued-turn-cancel.ts";
import { queueAndSendTelegramEgress, type TelegramEgressApi } from "./telegram-egress.ts";

/** Request to durably enqueue one Telegram user turn. */
export interface SubmitTelegramUserTurnRequest {
  ctx: TelegramContext;
  input: UserTurnInput;
  replyToMessageId: number;
  updateId: number;
  sessionId: string;
}

/** Result of durably enqueueing one Telegram user turn. */
export interface SubmitTelegramUserTurnResult {
  workId: string;
  sessionId: string;
}

/** Request to durably enqueue one cron run and notify Telegram that it started. */
export interface SubmitTelegramCronRunRequest {
  job: CronJob;
  sessionId: string;
  dispatchedAt: Date;
}

/** Request to cancel queued Telegram turns for one conversation. */
export interface CancelTelegramConversationRequest {
  target: TelegramQueuedTurnCancelTarget;
  reason: string;
  reply?: {
    ctx: TelegramContext;
    abortedActiveTurn: boolean;
  };
}

type CronStore = CronJobStore;

interface TelegramWorkIntakeOptions {
  queue: WorkQueue;
  events: EventStore;
  egressOutbox: EgressOutbox;
  imageStore: Pick<ImageStore, "putImages" | "deleteImages">;
  capabilityLedger: Pick<CapabilityLedger, "recordDecision">;
  cronStore: CronStore;
  sessions: TelegramSessionCoordinator;
  telegramApi: TelegramEgressApi;
  wakeQueue(): void;
  currentSessionId(): string;
}

function abortReplyText(abortedActiveTurn: boolean, cancelledQueuedTurns: number): string {
  if (abortedActiveTurn && cancelledQueuedTurns > 0) {
    return `Aborted current turn and cancelled ${cancelledQueuedTurns} queued turn${
      cancelledQueuedTurns === 1 ? "" : "s"
    }.`;
  }
  if (abortedActiveTurn) return "Aborted current turn.";
  if (cancelledQueuedTurns > 0) {
    return `Cancelled ${cancelledQueuedTurns} queued turn${cancelledQueuedTurns === 1 ? "" : "s"}.`;
  }
  return "No active turn.";
}

/** Owns durable Telegram work intake and pre-run queue side effects. */
export class TelegramWorkIntake {
  private readonly _queue: WorkQueue;
  private readonly _events: EventStore;
  private readonly _egressOutbox: EgressOutbox;
  private readonly _imageStore: Pick<ImageStore, "putImages" | "deleteImages">;
  private readonly _capabilityLedger: Pick<CapabilityLedger, "recordDecision">;
  private readonly _sessions: TelegramSessionCoordinator;
  private readonly _telegramApi: TelegramEgressApi;
  private readonly _wakeQueue: () => void;
  private readonly _currentSessionId: () => string;
  private readonly _liveContexts = new Map<string, TelegramContext>();

  constructor(options: TelegramWorkIntakeOptions) {
    this._queue = options.queue;
    this._events = options.events;
    this._egressOutbox = options.egressOutbox;
    this._imageStore = options.imageStore;
    this._capabilityLedger = options.capabilityLedger;
    this._sessions = options.sessions;
    this._telegramApi = options.telegramApi;
    this._wakeQueue = options.wakeQueue;
    this._currentSessionId = options.currentSessionId;
  }

  /** Returns the live Telegram context for queued work that has not restarted. */
  liveContext(workId: string): TelegramContext | undefined {
    return this._liveContexts.get(workId);
  }

  /** Removes a live Telegram context after work settles or is cancelled before leasing. */
  deleteLiveContext(workId: string): void {
    this._liveContexts.delete(workId);
  }

  /** Durably enqueues one Telegram user turn, then best-effort acknowledges and wakes the queue. */
  async submitUserTurn(request: SubmitTelegramUserTurnRequest): Promise<SubmitTelegramUserTurnResult> {
    const normalized = normalizeUserTurnInput(request.input);
    const message = request.ctx.message;
    if (!message) throw new Error("No Telegram message for model turn");

    const ref = telegramConversationRef(request.ctx);
    if (!ref) throw new Error("No Telegram conversation ref for model turn");

    let result: SubmitTelegramUserTurnResult | undefined;
    await this._sessions.withConversation(ref, async () => {
      const durableImageRefs = normalized.durableImages?.length ?
        await this._imageStore.putImages(normalized.durableImages) :
        undefined;
      let submitted = false;
      try {
        const sessionId = this._selectedSessionId(request.sessionId);
        const work = await this._queue.submit({
          kind: "user_turn",
          sessionId,
          payload: {
            input: {
              message: userTurnMessageData(normalized),
              ...(durableImageRefs?.length ? { durableImages: durableImageRefs } : {}),
            },
            telegram: {
              chatId: ref.chatId,
              ...(ref.threadId !== undefined ? { threadId: ref.threadId } : {}),
              replyToMessageId: request.replyToMessageId,
              updateId: request.updateId,
            },
          },
        });
        submitted = true;
        this._liveContexts.set(work.id, request.ctx);
        result = { workId: work.id, sessionId };
      } catch (error) {
        if (!submitted && durableImageRefs?.length) await this._imageStore.deleteImages(durableImageRefs);
        throw error;
      }

      try {
        await request.ctx.reply("Working on it...", {
          message_thread_id: message.message_thread_id,
        });
      } catch {
        /* best-effort ack after the turn is durably queued */
      }
      this._wakeQueue();
    });

    if (!result) throw new Error("Telegram user turn did not submit work");
    return result;
  }

  /** Durably enqueues one cron run, then best-effort sends the cron-start Telegram notification. */
  async submitCronRun(request: SubmitTelegramCronRunRequest): Promise<CronJobRunnerResult> {
    const ref = {
      chatId: request.job.chatId,
      ...(request.job.threadId !== undefined ? { threadId: request.job.threadId } : {}),
    };
    const existing = await this._queue.get(cronRunWorkId(request.job));
    if (existing) {
      const submission = cronRunWorkSubmissionForItem(existing);
      if (submission.status === "failed") throw new Error(submission.reason);
      return submission.status === "completed" ? { status: "completed" } : submission;
    }

    if (request.job.sessionMode === "fresh") {
      await this._sessions.replaceWithNew(ref, { topicName: request.job.topicName });
    }

    let result: CronJobRunnerResult | undefined;
    await this._sessions.withConversation(
      ref,
      async () => {
        const sessionId = this._selectedSessionId(request.sessionId);
        const submission = await submitCronRunWork({
          queue: this._queue,
          job: request.job,
          sessionId,
          dispatchedAt: request.dispatchedAt,
          capabilityLedger: this._capabilityLedger,
        });
        if (submission.status === "failed") throw new Error(submission.reason);
        result = submission.status === "completed" ? { status: "completed" } : submission;
        if (submission.status === "submitted") {
          try {
            await queueAndSendTelegramEgress({
              outbox: this._egressOutbox,
              api: this._telegramApi,
              workId: submission.workId,
              sessionId,
              target: {
                chatId: request.job.chatId,
                ...(request.job.threadId !== undefined ? { threadId: request.job.threadId } : {}),
                cronJobId: request.job.id,
              },
              replies: [],
              fallbackText: `Cron job ${request.job.id} started.\n${request.job.prompt}`,
            });
          } catch (error) {
            logError("telegram.cron_start_egress_failed", {
              jobId: request.job.id,
              message: errorMessage(error),
            });
          }
        }
        this._wakeQueue();
      },
      { topicName: request.job.topicName },
    );
    if (!result) throw new Error(`Cron job ${request.job.id} did not submit work`);
    return result;
  }

  /** Cancels queued turns for one Telegram conversation and cleans up associated live resources. */
  async cancelConversation(
    request: CancelTelegramConversationRequest,
  ): Promise<CancelQueuedTelegramUserTurnsResult> {
    const cancelled = await cancelQueuedTelegramUserTurns({
      events: this._events,
      queue: this._queue,
      target: request.target,
      reason: request.reason,
    });
    for (const workId of cancelled.cancelledWorkIds) this._liveContexts.delete(workId);
    if (cancelled.durableImages.length > 0) {
      try {
        await this._imageStore.deleteImages(cancelled.durableImages);
      } catch (error) {
        logError("telegram.queued_image_cleanup_failed", { message: errorMessage(error) });
      }
    }
    if (request.reply) {
      await request.reply.ctx.reply(
        abortReplyText(request.reply.abortedActiveTurn, cancelled.cancelledWorkIds.length),
        { message_thread_id: request.reply.ctx.message?.message_thread_id },
      );
    }
    return cancelled;
  }

  private _selectedSessionId(fallback: string): string {
    const current = this._currentSessionId();
    return current.length > 0 ? current : fallback;
  }
}
