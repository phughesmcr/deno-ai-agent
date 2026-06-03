// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import type { LMStudioClient } from "@lmstudio/sdk";
import type { UserTurnInput } from "../agent/user-turn.ts";
import {
  DEFAULT_IMAGE_PROMPT,
  downloadTelegramMessageImage,
  extractImageFileId,
  prepareTelegramImages,
} from "./telegram-image.ts";
import type { TelegramContext } from "./telegram.ts";

/**
 * Builds a {@link UserTurnInput} from a non-album Telegram message, or null when unsupported.
 * @internal
 */
export async function parseTelegramUserTurn(
  ctx: TelegramContext,
  client: LMStudioClient,
  botToken: string,
): Promise<UserTurnInput | null> {
  const message = ctx.message;
  if (!message) return null;

  if (message.media_group_id) return null;

  const text = message.text?.trim();
  const caption = message.caption?.trim();
  const fileId = extractImageFileId(message);

  if (fileId) {
    const item = await downloadTelegramMessageImage(ctx.api, botToken, message);
    const images = await prepareTelegramImages(client, [item]);
    return {
      text: caption ?? text ?? DEFAULT_IMAGE_PROMPT,
      images,
    };
  }

  if (text) return { text };

  return null;
}
