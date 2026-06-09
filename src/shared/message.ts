import type { ChatMessageData } from "@lmstudio/sdk";

import { isRecord, objectPayload } from "./record.ts";

/** Extracts concatenated text parts from a chat message. */
export function textFromMessage(message: ChatMessageData): string {
  return message.content.flatMap((part) => {
    if (!isRecord(part) || part["type"] !== "text") return [];
    const text = part["text"];
    return typeof text === "string" ? [text] : [];
  }).join("");
}

/** Extracts concatenated text parts from an untyped persisted message payload. */
export function textFromUnknownMessage(message: unknown): string {
  const record = objectPayload(message);
  const content = record?.["content"];
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const partRecord = objectPayload(part);
      return partRecord?.["type"] === "text" && typeof partRecord["text"] === "string" ? [partRecord["text"]] : [];
    })
    .join("");
}
