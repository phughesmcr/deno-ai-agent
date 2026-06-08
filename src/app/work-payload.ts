import type { ChatMessageData, FileHandle } from "@lmstudio/sdk";

import { type DurableUserImage, userTurnMessageData } from "../agent/user-turn.ts";
import type { WorkItem } from "../core/mod.ts";
import { parseTelegramEgressTarget, type TelegramEgressTarget } from "./telegram-egress.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function numberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function chatMessageData(value: unknown): ChatMessageData | undefined {
  if (!isRecord(value)) return undefined;
  if (value["role"] !== "user") return undefined;
  if (!Array.isArray(value["content"])) return undefined;
  return value as unknown as ChatMessageData;
}

function durableImage(value: unknown): QueuedDurableImage | undefined {
  if (!isRecord(value)) return undefined;
  const imageId = stringValue(value, "imageId");
  const fileName = stringValue(value, "fileName");
  const chunkCount = numberValue(value, "chunkCount");
  if (!imageId || !fileName || chunkCount === undefined) return undefined;
  if (!Number.isSafeInteger(chunkCount) || chunkCount <= 0) return undefined;
  return { imageId, fileName, chunkCount };
}

function durableImages(value: unknown): QueuedDurableImage[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const images = value.map((item) => durableImage(item));
  return images.every((item) => item !== undefined) ? images as QueuedDurableImage[] : undefined;
}

function queuedModelInput(value: unknown): QueuedModelInput | undefined {
  if (!isRecord(value)) return undefined;
  const message = chatMessageData(value["message"]);
  const images = durableImages(value["durableImages"]);
  if (!message || (value["durableImages"] !== undefined && !images)) return undefined;
  return {
    message,
    ...(images && images.length > 0 ? { durableImages: images } : {}),
  };
}

function textFromMessage(message: ChatMessageData): string {
  return message.content.flatMap((part) => {
    if (!isRecord(part) || part["type"] !== "text") return [];
    const text = part["text"];
    return typeof text === "string" ? [text] : [];
  }).join("");
}

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
  if (!isRecord(value)) throw new Error("Invalid user turn payload");
  const input = queuedModelInput(value["input"]);
  const telegram = parseTelegramEgressTarget(value["telegram"], { requireReplyToMessageId: true });
  if (!input || !telegram) throw new Error("Invalid user turn payload");
  return { input, telegram };
}

/** Parses and validates a durable cron run work payload. */
export function cronRunWorkPayload(value: unknown): CronRunWorkPayload {
  if (!isRecord(value)) throw new Error("Invalid cron run payload");
  const input = queuedModelInput(value["input"]);
  const telegram = parseTelegramEgressTarget(value["telegram"]);
  const prompt = stringValue(value, "prompt");
  const cron = isRecord(value["cron"]) ? value["cron"] : undefined;
  const jobId = cron ? stringValue(cron, "jobId") : undefined;
  const sessionMode = cron?.["sessionMode"];
  const dueAt = cron ? stringValue(cron, "dueAt") : undefined;
  const dispatchedAt = cron ? stringValue(cron, "dispatchedAt") : undefined;
  if (
    !prompt ||
    !input ||
    !telegram ||
    !cron ||
    !jobId ||
    (sessionMode !== "fresh" && sessionMode !== "persistent") ||
    !dueAt ||
    !dispatchedAt
  ) {
    throw new Error("Invalid cron run payload");
  }
  return {
    input,
    telegram,
    prompt,
    cron: {
      jobId,
      ...(stringValue(cron, "topicName") !== undefined ? { topicName: stringValue(cron, "topicName") } : {}),
      sessionMode,
      dueAt,
      dispatchedAt,
    },
  };
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
