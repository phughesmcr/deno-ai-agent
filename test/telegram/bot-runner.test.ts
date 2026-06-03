import { assertEquals } from "jsr:@std/assert@1";

import { telegramUpdateKey } from "../../src/telegram/telegram-update-key.ts";
import type { TelegramContext } from "../../src/telegram/telegram.ts";

function messageContext(text: string): TelegramContext {
  return {
    chat: { id: 123 },
    message: {
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(/\s+/, 1)[0]?.length ?? text.length }],
    },
  } as TelegramContext;
}

Deno.test("telegramUpdateKey does not queue /q behind an active message turn", () => {
  assertEquals(telegramUpdateKey(messageContext("/q")), undefined);
  assertEquals(telegramUpdateKey(messageContext("/q@SilasBot")), undefined);
});

Deno.test("telegramUpdateKey still serializes ordinary messages per chat", () => {
  assertEquals(telegramUpdateKey({ chat: { id: 123 }, message: { text: "hello" } } as TelegramContext), "msg:123");
  assertEquals(telegramUpdateKey(messageContext("/new")), "msg:123");
});
