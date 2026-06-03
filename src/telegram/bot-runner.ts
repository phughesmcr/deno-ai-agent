import { run, type RunnerHandle, sequentialize } from "@grammyjs/runner";
import type { Bot } from "grammy";

import type { TelegramContext } from "./telegram.ts";
import { telegramUpdateKey } from "./telegram-update-key.ts";

/**
 * Serializes plain messages per chat, but lets callback queries (approvals, pm:, questions)
 * and `/q` run while a long `model.act()` turn is in progress. `bot.start()` would queue
 * callbacks behind the message handler and cause approval timeouts.
 */
export function installConcurrentUpdates(bot: Bot<TelegramContext>): void {
  bot.use(sequentialize(telegramUpdateKey));
}

/** Starts long-polling with concurrent update processing. */
export function startTelegramBot(bot: Bot<TelegramContext>): RunnerHandle {
  return run(bot);
}
