import { botCommandName } from "./is-bot-command.ts";
import { telegramConversationKey, telegramConversationRef } from "./conversation.ts";
import type { TelegramContext } from "./telegram.ts";

function commandName(ctx: TelegramContext): string | undefined {
  const message = ctx.message;
  if (!message) return undefined;
  return botCommandName(message);
}

/** Returns the runner sequentialization key for an update. */
export function telegramUpdateKey(ctx: TelegramContext): string | undefined {
  if (ctx.callbackQuery) return undefined;
  if (commandName(ctx) === "q") return undefined;
  const ref = telegramConversationRef(ctx);
  return ref === undefined ? undefined : `msg:${telegramConversationKey(ref)}`;
}
