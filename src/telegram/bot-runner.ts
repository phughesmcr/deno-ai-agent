import { createRequire } from "node:module";
import type { RunnerHandle, RunOptions } from "@grammyjs/runner";
import type { Bot } from "grammy";

import type { TelegramContext } from "./telegram.ts";
import { telegramUpdateKey } from "./telegram-update-key.ts";

const TELEGRAM_RUNNER_CONCURRENCY = 8;
const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"] as const;

type GrammyRunnerModule = typeof import("@grammyjs/runner");
type TelegramRunner = GrammyRunnerModule["run"];

const require = createRequire(import.meta.url);

function grammyRunner(): GrammyRunnerModule {
  return require("@grammyjs/runner") as GrammyRunnerModule;
}

function telegramRunnerOptions(): RunOptions<TelegramContext["update"]> {
  return {
    runner: {
      fetch: {
        allowed_updates: TELEGRAM_ALLOWED_UPDATES,
      },
    },
    sink: {
      concurrency: TELEGRAM_RUNNER_CONCURRENCY,
    },
  };
}

/**
 * Serializes plain messages per chat, but lets callback queries (capability prompts, cp:, questions)
 * and `/q` run while a long `model.act()` turn is in progress. `bot.start()` would queue
 * callbacks behind the message handler and cause capability prompt timeouts.
 */
export function installConcurrentUpdates(bot: Bot<TelegramContext>): void {
  const { sequentialize } = grammyRunner();
  bot.use(sequentialize(telegramUpdateKey));
}

/** Starts long-polling with concurrent update processing. */
export function startTelegramBot(bot: Bot<TelegramContext>, runBot: TelegramRunner = grammyRunner().run): RunnerHandle {
  return runBot(bot, telegramRunnerOptions());
}
