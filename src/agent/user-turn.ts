import { ChatMessage, type ChatMessageData, type FileHandle } from "@lmstudio/sdk";

/** @internal SDK exposes getRaw() at runtime but not in public types. */
type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

/** Durable image payload stored with queued work so image turns survive process restart. */
export interface DurableUserImage {
  /** File name sent to LM Studio when preparing the image. */
  fileName: string;
  /** Base64-encoded image bytes. */
  base64: string;
}

/** User message payload for one model turn (text plus optional vision attachments). */
export interface UserTurnInput {
  /** User text or image caption. */
  text: string;
  /** LM Studio image handles from `client.files.prepareImage*`. */
  images?: FileHandle[];
  /** Durable image bytes used to recreate LM Studio image handles after restart. */
  durableImages?: DurableUserImage[];
}

/** Normalizes a string or structured user turn into {@link UserTurnInput}. */
export function normalizeUserTurnInput(input: string | UserTurnInput): UserTurnInput {
  return typeof input === "string" ? { text: input } : input;
}

/** Serializes a user turn into durable LM Studio chat message data. */
export function userTurnMessageData(input: UserTurnInput): ChatMessageData {
  const message = ChatMessage.create("user", input.text);
  for (const image of input.images ?? []) message.appendFile(image);
  return (message as ChatMessageWithRaw).getRaw();
}

/** Counts image attachments in serialized user turn message data. */
export function userTurnImageCount(message: ChatMessageData): number {
  return message.content.filter((part) => part.type === "file" && part.fileType === "image").length;
}
