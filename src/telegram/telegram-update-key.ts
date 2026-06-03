import type { TelegramContext } from "./telegram.ts";
import { isBotCommand } from "./is-bot-command.ts";

function commandName(ctx: TelegramContext): string | undefined {
  const message = ctx.message;
  if (!message || !isBotCommand(message)) return undefined;
  const command = message.entities?.find((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (!command || !message.text) return undefined;
  return message.text.slice(1, command.length).split("@", 1)[0];
}

/** Returns the runner sequentialization key for an update. */
export function telegramUpdateKey(ctx: TelegramContext): string | undefined {
  if (ctx.callbackQuery) return undefined;
  if (commandName(ctx) === "q") return undefined;
  const chatId = ctx.chat?.id;
  return chatId === undefined ? undefined : `msg:${chatId}`;
}
