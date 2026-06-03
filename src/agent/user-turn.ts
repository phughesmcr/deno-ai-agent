import type { FileHandle } from "@lmstudio/sdk";

/** User message payload for one model turn (text plus optional vision attachments). */
export interface UserTurnInput {
  /** User text or image caption. */
  text: string;
  /** LM Studio image handles from `client.files.prepareImage*`. */
  images?: FileHandle[];
}

/** Normalizes a string or structured user turn into {@link UserTurnInput}. */
export function normalizeUserTurnInput(input: string | UserTurnInput): UserTurnInput {
  return typeof input === "string" ? { text: input } : input;
}
