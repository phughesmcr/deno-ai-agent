import { assertEquals } from "jsr:@std/assert@1";

import { CronCommandManager } from "../../src/cron/commands.ts";
import { CronJobStore } from "../../src/cron/store.ts";

async function withStore(fn: (store: CronJobStore) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(new CronJobStore(kv));
  } finally {
    kv.close();
  }
}

Deno.test("CronCommandManager creates a dedicated topic for new cron jobs", async () => {
  await withStore(async (store) => {
    const manager = new CronCommandManager({
      store,
      ref: { chatId: 123, threadId: 10 },
      mcpTools: () => [],
      createTopic: (name) => {
        assertEquals(name, "Cron: every 2 minutes");
        return Promise.resolve({ threadId: 99, topicName: name });
      },
    });

    const text = await manager.create('every 2 minutes, prompt me "WAKE UP!!"');
    const jobs = await store.listForChat(123);

    assertEquals(jobs.length, 1);
    assertEquals(jobs[0]?.threadId, 99);
    assertEquals(jobs[0]?.topicName, "Cron: every 2 minutes");
    assertEquals(text.includes("Topic: Cron: every 2 minutes"), true);
  });
});

Deno.test("CronCommandManager changes cron session mode", async () => {
  await withStore(async (store) => {
    const created = await store.create({
      chatId: 123,
      threadId: 99,
      prompt: "Review code",
      scheduleText: "every 1 hours",
      timezone: "UTC",
      nextRunAt: "2026-06-06T08:00:00.000Z",
      permissionProfile: { toolRules: [], brokerRules: [] },
    });
    const manager = new CronCommandManager({
      store,
      ref: { chatId: 123 },
      mcpTools: () => [],
    });

    assertEquals(await manager.setMode(created.id, "persistent"), true);
    assertEquals((await store.get(created.id))?.sessionMode, "persistent");
  });
});
