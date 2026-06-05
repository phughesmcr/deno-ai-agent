import { assertEquals, assertExists } from "jsr:@std/assert@1";

import { TelegramSessionBindingStore } from "../../src/telegram/session-binding-store.ts";

async function withKv(fn: (store: TelegramSessionBindingStore) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(new TelegramSessionBindingStore(kv));
  } finally {
    kv.close();
  }
}

Deno.test("TelegramSessionBindingStore creates and returns existing bindings atomically", async () => {
  await withKv(async (store) => {
    const created = await store.createIfMissing(
      { chatId: 1, threadId: 10 },
      { sessionId: "session-a", createdBy: 99, topicName: "Work" },
    );
    const existing = await store.createIfMissing(
      { chatId: 1, threadId: 10 },
      { sessionId: "session-b", createdBy: 99 },
    );

    assertEquals(created.created, true);
    assertEquals(existing.created, false);
    assertEquals(existing.binding.sessionId, "session-a");
    assertEquals(existing.binding.topicName, "Work");
  });
});

Deno.test("TelegramSessionBindingStore rebinds while preserving createdAt", async () => {
  await withKv(async (store) => {
    const first = await store.bind({ chatId: 1 }, { sessionId: "first" });
    const second = await store.bind({ chatId: 1 }, { sessionId: "second" });

    assertEquals(second.sessionId, "second");
    assertEquals(second.createdAt, first.createdAt);
    assertExists(second.updatedAt);
  });
});

Deno.test("TelegramSessionBindingStore concurrent rebinds preserve the first createdAt", async () => {
  await withKv(async (store) => {
    const bindings = await Promise.all(
      Array.from(
        { length: 16 },
        (_, index) => store.bind({ chatId: 1, threadId: 10 }, { sessionId: `session-${index}` }),
      ),
    );
    const final = await store.get({ chatId: 1, threadId: 10 });

    assertExists(final);
    assertEquals(new Set(bindings.map((binding) => binding.createdAt)).size, 1);
    assertEquals(bindings[0]?.createdAt, final.createdAt);
  });
});

Deno.test("TelegramSessionBindingStore lists chat bindings without main/topic collisions", async () => {
  await withKv(async (store) => {
    await store.bind({ chatId: 1 }, { sessionId: "main" });
    await store.bind({ chatId: 1, threadId: 2 }, { sessionId: "topic-2" });
    await store.bind({ chatId: 1, threadId: 1 }, { sessionId: "topic-1" });
    await store.bind({ chatId: 2, threadId: 1 }, { sessionId: "other-chat" });

    const main = await store.get({ chatId: 1 });
    assertEquals(main?.sessionId, "main");
    assertEquals(main?.threadId, undefined);
    assertEquals(main, {
      chatId: 1,
      sessionId: "main",
      createdAt: main?.createdAt ?? "",
      updatedAt: main?.updatedAt ?? "",
    });
    assertEquals((await store.get({ chatId: 1, threadId: 1 }))?.sessionId, "topic-1");
    assertEquals((await store.get({ chatId: 1, threadId: 2 }))?.sessionId, "topic-2");

    const bindings = await store.listForChat(1);
    assertEquals(bindings.map((binding) => binding.sessionId), ["main", "topic-1", "topic-2"]);
  });
});
