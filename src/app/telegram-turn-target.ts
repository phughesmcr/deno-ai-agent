import type { EgressOutbox, LeasedWorkItem } from "../core/mod.ts";
import type { TelegramCapabilityTurnContext } from "../telegram/capability-prompt.ts";
import type { TodoDisplayContext } from "../telegram/grammy-todo-display-adapter.ts";
import { queueAndSendTelegramEgress, type TelegramEgressApi } from "./telegram-egress.ts";
import type { UserTurnWorkPayload } from "./work-payload.ts";

/** Telegram API surface needed by recovered queued turns. */
export interface QueuedTelegramTurnApi extends TelegramEgressApi {
  /** Sends one Telegram message and returns its message id. */
  sendMessage(
    chatId: number,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  /** Edits an existing Telegram message for todo display updates. */
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

/** Minimal turn context for recovered Telegram prompts and todo display. */
export type QueuedTelegramTurnContext = TelegramCapabilityTurnContext & TodoDisplayContext;

/** Creates a narrow Telegram turn context for durable work recovered after process restart. */
export function createQueuedTelegramTurnContext(options: {
  target: UserTurnWorkPayload["telegram"];
  adminId: number;
  api: QueuedTelegramTurnApi;
}): QueuedTelegramTurnContext {
  return {
    config: { adminId: options.adminId, isAdmin: true },
    chat: { id: options.target.chatId },
    message: {
      chat: { id: options.target.chatId },
      message_thread_id: options.target.threadId,
    },
    api: options.api,
    reply: (text, replyOptions) =>
      options.api.sendMessage(options.target.chatId, text, {
        ...replyOptions,
        message_thread_id: typeof replyOptions?.message_thread_id === "number" ?
          replyOptions.message_thread_id :
          options.target.threadId,
      }),
  };
}

/** Queues and sends a Telegram model reply for a leased queued turn. */
export async function sendQueuedTelegramModelReply(options: {
  outbox: EgressOutbox;
  api: TelegramEgressApi;
  work: LeasedWorkItem;
  payload: UserTurnWorkPayload;
  replyTexts: readonly string[];
  fallbackText: string;
}): Promise<void> {
  await queueAndSendTelegramEgress({
    outbox: options.outbox,
    api: options.api,
    workId: options.work.id,
    sessionId: options.work.sessionId,
    target: options.payload.telegram,
    replies: options.replyTexts,
    ...(options.replyTexts.length === 0 ? { fallbackText: options.fallbackText } : {}),
  });
}
