import { assertEquals } from "jsr:@std/assert@1";
import type { RunOptions } from "@grammyjs/runner";
import type { Bot } from "grammy";

import { startTelegramBot } from "../../src/telegram/bot-runner.ts";
import { telegramUpdateKey } from "../../src/telegram/telegram-update-key.ts";
import type { TelegramContext } from "../../src/telegram/telegram.ts";

function messageContext(text: string, threadId?: number): TelegramContext {
  return {
    chat: { id: 123 },
    message: {
      text,
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      entities: [{ type: "bot_command", offset: 0, length: text.split(/\s+/, 1)[0]?.length ?? text.length }],
    },
  } as TelegramContext;
}

Deno.test("startTelegramBot starts the runner with bounded Telegram update options", () => {
  let runnerOptions: RunOptions<TelegramContext["update"]> | undefined;
  const bot = {} as Bot<TelegramContext>;
  const handle: ReturnType<typeof startTelegramBot> = {
    start: () => undefined,
    stop: () => Promise.resolve(),
    size: () => 0,
    task: () => undefined,
    isRunning: () => false,
  };
  const runBot: NonNullable<Parameters<typeof startTelegramBot>[1]> = (_bot, options) => {
    runnerOptions = options as RunOptions<TelegramContext["update"]>;
    return handle;
  };

  assertEquals(startTelegramBot(bot, runBot), handle);
  assertEquals(runnerOptions?.runner?.fetch?.allowed_updates, ["message", "callback_query"]);
  assertEquals(runnerOptions?.sink?.concurrency, 8);
});

Deno.test("telegramUpdateKey does not queue /q behind an active message turn", () => {
  assertEquals(telegramUpdateKey(messageContext("/q")), undefined);
  assertEquals(telegramUpdateKey(messageContext("/q@SilasBot")), undefined);
});

Deno.test("telegramUpdateKey still serializes ordinary messages per chat", () => {
  assertEquals(
    telegramUpdateKey({ chat: { id: 123 }, message: { text: "hello" } } as TelegramContext),
    "msg:123:main",
  );
  assertEquals(telegramUpdateKey(messageContext("/new")), "msg:123:main");
  assertEquals(telegramUpdateKey(messageContext("/new", 77)), "msg:123:thread:77");
});
