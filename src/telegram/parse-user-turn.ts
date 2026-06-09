// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import type { LMStudioClient } from "@lmstudio/sdk";
import type { UserTurnInput } from "../agent/user-turn.ts";
import { type AudioTranscriber, downloadTelegramMessageAudio, extractAudioFileId } from "./audio.ts";
import {
  DEFAULT_IMAGE_PROMPT,
  downloadTelegramMessageImage,
  durableTelegramImages,
  extractImageFileId,
  prepareDurableUserImages,
} from "./image.ts";
import type { TelegramContext } from "./telegram.ts";

/**
 * Builds a {@link UserTurnInput} from a non-album Telegram message, or null when unsupported.
 * @internal
 */
export async function parseTelegramUserTurn(
  ctx: TelegramContext,
  client: LMStudioClient,
  botToken: string,
  audioTranscriber?: AudioTranscriber,
): Promise<UserTurnInput | null> {
  const message = ctx.message;
  if (!message) return null;

  if (message.media_group_id) return null;

  const text = message.text?.trim();
  const caption = message.caption?.trim();
  const fileId = extractImageFileId(message);
  const audioFileId = extractAudioFileId(message);

  if (fileId) {
    const item = await downloadTelegramMessageImage(ctx.api, botToken, message);
    const durableImages = await durableTelegramImages([item]);
    const images = await prepareDurableUserImages(client, durableImages);
    return {
      text: caption ?? text ?? DEFAULT_IMAGE_PROMPT,
      images,
      durableImages,
    };
  }

  if (audioFileId) {
    if (!audioTranscriber) return null;
    const item = await downloadTelegramMessageAudio(ctx.api, botToken, message);
    const transcript = await audioTranscriber.transcribe(item);
    return {
      text: caption ? `${caption}\n\n[Transcribed audio]\n${transcript}` : transcript,
    };
  }

  if (text) return { text };

  return null;
}
