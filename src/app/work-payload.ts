import type { ChatMessageData, FileHandle } from "@lmstudio/sdk";
import { z } from "zod";

import { type DurableUserImage, userTurnMessageData } from "../agent/user-turn.ts";
import type { WorkItem } from "../core/mod.ts";
import { textFromMessage } from "../shared/message.ts";
import type { TelegramEgressTarget } from "./telegram-egress.ts";

/** Durable queued image reference stored in the work payload. */
export interface QueuedDurableImage {
  /** Stable image payload id in the durable image store. */
  imageId: string;
  /** Original file name for LM Studio upload. */
  fileName: string;
  /** Number of base64 chunks stored for this image. */
  chunkCount: number;
}

/** Serialized model input stored on queued work. */
export interface QueuedModelInput {
  /** User chat message to append to the session when the worker runs. */
  message: ChatMessageData;
  /** Durable image refs used to recreate LM Studio image handles after restart. */
  durableImages?: QueuedDurableImage[];
}

/** Durable user turn payload. */
export interface UserTurnWorkPayload {
  /** Serialized model input. */
  input: QueuedModelInput;
  /** Telegram destination for replies and prompts. */
  telegram: TelegramEgressTarget;
}

/** Durable cron run payload. */
export interface CronRunWorkPayload extends UserTurnWorkPayload {
  /** Original cron prompt. */
  prompt: string;
  /** Cron metadata for observability. */
  cron: {
    /** Cron job id. */
    jobId: string;
    /** Telegram topic name, when known. */
    topicName?: string;
    /** Whether the cron job starts fresh or keeps context. */
    sessionMode: "fresh" | "persistent";
    /** Due timestamp for the scheduled occurrence. */
    dueAt: string;
    /** Timestamp when the dispatcher submitted this run. */
    dispatchedAt: string;
  };
}

const userChatMessageDataSchema = z.custom<ChatMessageData>((value) => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record["role"] === "user" && Array.isArray(record["content"]);
});

const queuedDurableImageSchema = z.object({
  imageId: z.string(),
  fileName: z.string(),
  chunkCount: z.number().int().positive(),
}) satisfies z.ZodType<QueuedDurableImage>;

const queuedModelInputSchema = z.object({
  message: userChatMessageDataSchema,
  durableImages: z.array(queuedDurableImageSchema).optional(),
}) satisfies z.ZodType<QueuedModelInput>;

const telegramEgressTargetSchema = z.object({
  chatId: z.number(),
  threadId: z.number().optional(),
  replyToMessageId: z.number().optional(),
  updateId: z.number().optional(),
  cronJobId: z.string().optional(),
}) satisfies z.ZodType<TelegramEgressTarget>;

const userTurnWorkPayloadSchema = z.object({
  input: queuedModelInputSchema,
  telegram: telegramEgressTargetSchema.refine(
    (target) => target.replyToMessageId !== undefined,
    { message: "replyToMessageId is required for user turns" },
  ),
}) satisfies z.ZodType<UserTurnWorkPayload>;

const cronRunWorkPayloadSchema = z.object({
  input: queuedModelInputSchema,
  telegram: telegramEgressTargetSchema,
  prompt: z.string(),
  cron: z.object({
    jobId: z.string(),
    topicName: z.string().optional(),
    sessionMode: z.enum(["fresh", "persistent"]),
    dueAt: z.string(),
    dispatchedAt: z.string(),
  }),
}) satisfies z.ZodType<CronRunWorkPayload>;

/** Rebuilds queued model input with fresh image handles when durable image bytes are available. */
export async function prepareQueuedModelMessage(
  input: QueuedModelInput,
  loadImages: (images: readonly QueuedDurableImage[]) => Promise<DurableUserImage[]>,
  prepareImages: (images: readonly DurableUserImage[]) => Promise<FileHandle[]>,
): Promise<ChatMessageData> {
  if (!input.durableImages?.length) return input.message;
  const durableImages = await loadImages(input.durableImages);
  const handles = await prepareImages(durableImages);
  return userTurnMessageData({ text: textFromMessage(input.message), images: handles });
}

/** Parses and validates a durable user turn work payload. */
export function userTurnWorkPayload(value: unknown): UserTurnWorkPayload {
  try {
    return userTurnWorkPayloadSchema.parse(value);
  } catch {
    throw new Error("Invalid user turn payload");
  }
}

/** Parses and validates a durable cron run work payload. */
export function cronRunWorkPayload(value: unknown): CronRunWorkPayload {
  try {
    return cronRunWorkPayloadSchema.parse(value);
  } catch {
    throw new Error("Invalid cron run payload");
  }
}

/** Extracts the Telegram egress target from work payloads that can notify Telegram on recovery. */
export function telegramTargetForWork(work: WorkItem): TelegramEgressTarget | undefined {
  try {
    if (work.kind === "user_turn") return userTurnWorkPayload(work.payload).telegram;
    if (work.kind === "cron_run") return cronRunWorkPayload(work.payload).telegram;
  } catch {
    return undefined;
  }
  return undefined;
}
