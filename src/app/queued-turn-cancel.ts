import type { EventStore, WorkQueue } from "../core/mod.ts";
import { type QueuedDurableImage, type UserTurnWorkPayload, userTurnWorkPayload } from "./work-payload.ts";

/** Telegram conversation identity used to cancel still-queued turns. */
export interface TelegramQueuedTurnCancelTarget {
  /** Telegram chat id. */
  chatId: number;
  /** Telegram forum topic thread id, when the turn belongs to a topic. */
  threadId?: number;
}

/** Result of cancelling queued Telegram work. */
export interface CancelQueuedTelegramUserTurnsResult {
  /** Work ids that reached cancelled status. */
  cancelledWorkIds: string[];
  /** Durable image refs attached to cancelled work and now safe to delete. */
  durableImages: QueuedDurableImage[];
}

/** Options for cancelling queued Telegram user-turn work. */
export interface CancelQueuedTelegramUserTurnsOptions {
  /** Durable events used to discover submitted work ids. */
  events: EventStore;
  /** Durable queue that owns current work state. */
  queue: WorkQueue;
  /** Conversation whose queued user turns should be cancelled. */
  target: TelegramQueuedTurnCancelTarget;
  /** Cancellation reason persisted on work and events. */
  reason?: string;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

function sameTelegramConversation(
  left: TelegramQueuedTurnCancelTarget,
  right: TelegramQueuedTurnCancelTarget,
): boolean {
  return left.chatId === right.chatId && left.threadId === right.threadId;
}

function parseQueuedUserTurnPayload(value: unknown): UserTurnWorkPayload | undefined {
  try {
    return userTurnWorkPayload(value);
  } catch {
    return undefined;
  }
}

/** Cancels not-yet-started Telegram user turns for one conversation. */
export async function cancelQueuedTelegramUserTurns(
  options: CancelQueuedTelegramUserTurnsOptions,
): Promise<CancelQueuedTelegramUserTurnsResult> {
  const result: CancelQueuedTelegramUserTurnsResult = {
    cancelledWorkIds: [],
    durableImages: [],
  };
  const seenWorkIds = new Set<string>();
  const reason = options.reason ?? "Turn cancelled before it started.";

  for (const event of await options.events.list()) {
    if (event.category !== "work.created" || event.workId === undefined || seenWorkIds.has(event.workId)) {
      continue;
    }
    seenWorkIds.add(event.workId);

    const work = await options.queue.get(event.workId);
    if (!work || work.kind !== "user_turn" || work.status !== "queued") continue;

    const payload = parseQueuedUserTurnPayload(work.payload);
    if (!payload || !sameTelegramConversation(options.target, payload.telegram)) continue;

    await options.queue.cancel(work.id, {
      reason,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    const cancelled = await options.queue.get(work.id);
    if (cancelled?.status !== "cancelled") continue;

    result.cancelledWorkIds.push(work.id);
    if (payload.input.durableImages?.length) {
      result.durableImages.push(...payload.input.durableImages);
    }
  }

  return result;
}
