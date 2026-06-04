import { assertEquals } from "jsr:@std/assert@1";

import {
  telegramConversationKey,
  telegramConversationRef,
  telegramThreadKey,
} from "../../src/telegram/conversation.ts";

Deno.test("telegramConversationRef derives refs from ordinary messages", () => {
  assertEquals(telegramConversationRef({ chat: { id: 1 }, message: {} }), { chatId: 1 });
  assertEquals(
    telegramConversationRef({ chat: { id: -100 }, message: { message_thread_id: 42 } }),
    { chatId: -100, threadId: 42 },
  );
});

Deno.test("telegramConversationRef derives refs from callback messages", () => {
  assertEquals(
    telegramConversationRef({
      callbackQuery: { message: { chat: { id: -200 }, message_thread_id: 9 } },
    }),
    { chatId: -200, threadId: 9 },
  );
});

Deno.test("telegramConversationRef returns undefined without a chat id", () => {
  assertEquals(telegramConversationRef({ message: { message_thread_id: 42 } }), undefined);
});

Deno.test("telegram conversation keys distinguish main chat and topics", () => {
  assertEquals(telegramThreadKey(undefined), "main");
  assertEquals(telegramThreadKey(42), "thread:42");
  assertEquals(telegramConversationKey({ chatId: 1 }), "1:main");
  assertEquals(telegramConversationKey({ chatId: 1, threadId: 42 }), "1:thread:42");
});
