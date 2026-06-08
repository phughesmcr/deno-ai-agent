import type { EgressOutbox, PendingEgress, QueuedEgressPayload } from "../core/mod.ts";
import { errorMessage, logError } from "../shared/mod.ts";
import { sendModelTextReply, type TelegramReplyOptions } from "../telegram/model-reply.ts";

/** Telegram destination persisted in durable egress events. */
export interface TelegramEgressTarget {
  /** Chat id to send into. */
  chatId: number;
  /** Optional forum topic thread id. */
  threadId?: number;
  /** Message id the first reply should target, when this egress is tied to a source message. */
  replyToMessageId?: number;
  /** Original Telegram update id, when user-created. */
  updateId?: number;
  /** Cron job id, when cron-created. */
  cronJobId?: string;
}

/** Minimal Telegram API surface needed to render queued egress. */
export interface TelegramEgressApi {
  /** Sends one Telegram message. */
  sendMessage(chatId: number, text: string, options?: TelegramReplyOptions): Promise<unknown>;
}

/** Result of draining pending Telegram egress. */
export interface DrainTelegramEgressResult {
  /** Number of pending outbox records considered. */
  pending: number;
  /** Number successfully sent and marked as sent. */
  sent: number;
  /** Number skipped because their durable record was not renderable. */
  skipped: number;
  /** Number that failed during Telegram send and were left pending. */
  failed: number;
  /** Number permanently dropped because Telegram rejected the destination. */
  dropped: number;
}

/** Options for draining pending Telegram egress on startup. */
export interface DrainTelegramEgressOutboxOptions {
  /** Durable outbox to replay. */
  outbox: EgressOutbox;
  /** Telegram API sender. */
  api: TelegramEgressApi;
  /** Optional shutdown signal. */
  signal?: AbortSignal;
}

/** Options for queueing one live Telegram egress payload and rendering it immediately. */
export interface QueueAndSendTelegramEgressOptions {
  /** Durable outbox to write before the Telegram side effect. */
  outbox: EgressOutbox;
  /** Telegram API sender. */
  api: TelegramEgressApi;
  /** Work item associated with this egress. */
  workId: string;
  /** Session associated with this egress. */
  sessionId: string;
  /** Telegram destination for replies. */
  target: TelegramEgressTarget;
  /** Assistant reply chunks to render. */
  replies: readonly string[];
  /** Fallback text when no assistant reply chunks exist. */
  fallbackText?: string;
  /** Stable egress id override for tests or recovery. */
  egressId?: string;
  /** Deterministic clock for tests. */
  now?: Date;
}

/** Renderable Telegram reply payload. */
export interface TelegramEgressPayload {
  /** Telegram destination for replies. */
  target: TelegramEgressTarget;
  /** Assistant reply chunks to render. */
  replies: readonly string[];
  /** Fallback text when no assistant reply chunks exist. */
  fallbackText?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** Parses a durable Telegram egress target. */
export function parseTelegramEgressTarget(
  value: unknown,
  options?: { requireReplyToMessageId?: boolean },
): TelegramEgressTarget | undefined {
  if (!isRecord(value)) return undefined;
  const chatId = value["chatId"];
  const replyToMessageId = value["replyToMessageId"];
  if (typeof chatId !== "number") return undefined;
  if (replyToMessageId !== undefined && typeof replyToMessageId !== "number") return undefined;
  if (options?.requireReplyToMessageId && replyToMessageId === undefined) return undefined;
  return {
    chatId,
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(optionalNumber(value, "threadId") !== undefined ? { threadId: optionalNumber(value, "threadId") } : {}),
    ...(optionalNumber(value, "updateId") !== undefined ? { updateId: optionalNumber(value, "updateId") } : {}),
    ...(optionalString(value, "cronJobId") !== undefined ? { cronJobId: optionalString(value, "cronJobId") } : {}),
  };
}

/** Sends one Telegram egress payload through the supplied API. */
export async function sendTelegramEgressPayload(
  api: TelegramEgressApi,
  payload: TelegramEgressPayload,
): Promise<void> {
  if (payload.replies.length > 0) {
    await sendModelTextReply(
      {
        reply: (text, options) => api.sendMessage(payload.target.chatId, text, options),
      },
      payload.replies,
      payload.target.replyToMessageId,
      payload.target.threadId,
    );
    return;
  }
  await api.sendMessage(payload.target.chatId, payload.fallbackText ?? "The model finished without a reply.", {
    message_thread_id: payload.target.threadId,
  });
}

/** Returns true for Telegram errors where retrying the same target cannot succeed. */
export function isPermanentTelegramSendFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("message thread not found") ||
    message.includes("chat not found") ||
    message.includes("bot was blocked") ||
    message.includes("user is deactivated") ||
    message.includes("replied message not found") ||
    message.includes("message to edit not found");
}

function logInvalidPendingEgress(pending: PendingEgress, reason: string): void {
  logError("telegram.egress.invalid_pending", {
    eventId: pending.event.id,
    reason,
    sequence: String(pending.event.sequence),
  });
}

async function markDropped(
  outbox: EgressOutbox,
  workId: string,
  sessionId: string,
  payload: QueuedEgressPayload<TelegramEgressTarget>,
  reason: string,
): Promise<void> {
  await outbox.markDropped({
    workId,
    sessionId,
    payload,
    reason,
  });
}

/** Queues one Telegram egress payload, sends it, and marks it sent only after Telegram accepts it. */
export async function queueAndSendTelegramEgress(
  options: QueueAndSendTelegramEgressOptions,
): Promise<QueuedEgressPayload<TelegramEgressTarget>> {
  const queued = await options.outbox.queue<TelegramEgressTarget>({
    workId: options.workId,
    sessionId: options.sessionId,
    target: options.target,
    replies: options.replies,
    ...(options.fallbackText !== undefined ? { fallbackText: options.fallbackText } : {}),
    ...(options.egressId !== undefined ? { egressId: options.egressId } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  try {
    await sendTelegramEgressPayload(options.api, { ...queued.payload, target: options.target });
    await options.outbox.markSent({
      workId: options.workId,
      sessionId: options.sessionId,
      payload: queued.payload,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  } catch (error) {
    if (!isPermanentTelegramSendFailure(error)) throw error;
    await options.outbox.markDropped({
      workId: options.workId,
      sessionId: options.sessionId,
      payload: queued.payload,
      reason: errorMessage(error),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  }
  return queued.payload;
}

/** Sends pending durable Telegram egress and marks it sent only after Telegram accepts it. */
export async function drainTelegramEgressOutbox(
  options: DrainTelegramEgressOutboxOptions,
): Promise<DrainTelegramEgressResult> {
  const pendingItems = await options.outbox.listPending<TelegramEgressTarget>();
  const result: DrainTelegramEgressResult = {
    pending: pendingItems.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    dropped: 0,
  };

  for (const pending of pendingItems) {
    options.signal?.throwIfAborted();
    const workId = pending.event.workId;
    const sessionId = pending.event.sessionId;
    if (workId === undefined || sessionId === undefined) {
      result.skipped++;
      logInvalidPendingEgress(pending, "missing_work_or_session");
      continue;
    }

    const target = parseTelegramEgressTarget(pending.payload.target);
    if (!target) {
      result.skipped++;
      await markDropped(options.outbox, workId, sessionId, pending.payload, "invalid_telegram_target");
      result.dropped++;
      logInvalidPendingEgress(pending, "invalid_telegram_target");
      continue;
    }

    try {
      await sendTelegramEgressPayload(options.api, { ...pending.payload, target });
      await options.outbox.markSent({ workId, sessionId, payload: pending.payload });
      result.sent++;
    } catch (error) {
      if (isPermanentTelegramSendFailure(error)) {
        await markDropped(options.outbox, workId, sessionId, pending.payload, errorMessage(error));
        result.dropped++;
        logError("telegram.egress.replay_dropped", {
          eventId: pending.event.id,
          sequence: String(pending.event.sequence),
          message: errorMessage(error),
        });
        continue;
      }
      result.failed++;
      logError("telegram.egress.replay_failed", {
        eventId: pending.event.id,
        sequence: String(pending.event.sequence),
        message: errorMessage(error),
      });
    }
  }

  return result;
}
