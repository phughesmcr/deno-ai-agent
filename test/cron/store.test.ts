import { assertEquals, assertExists } from "jsr:@std/assert@1";

import { type CreateCronJobInput, CronJobStore } from "../../src/cron/store.ts";

const input: CreateCronJobInput = {
  chatId: 1,
  prompt: "Check Gmail and summarize actions.",
  scheduleText: "Every morning at 8am",
  timezone: "Europe/London",
  nextRunAt: "2026-06-06T07:00:00.000Z",
  permissionProfile: {
    toolRules: [{ operation: "mcp", target: "gmail/search" }],
    brokerRules: [],
  },
};

async function withStore(fn: (store: CronJobStore) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(new CronJobStore(kv));
  } finally {
    kv.close();
  }
}

Deno.test("CronJobStore creates, lists, and deletes chat jobs", async () => {
  await withStore(async (store) => {
    const created = await store.create(input);
    const listed = await store.listForChat(1);

    assertEquals(listed.map((job) => job.id), [created.id]);
    assertEquals(listed[0]?.prompt, input.prompt);

    await store.delete(created.id);
    assertEquals(await store.listForChat(1), []);
  });
});

Deno.test("CronJobStore lists due enabled jobs by nextRunAt", async () => {
  await withStore(async (store) => {
    const due = await store.create(input);
    await store.create({ ...input, nextRunAt: "2026-06-07T07:00:00.000Z" });

    assertEquals((await store.listDue("2026-06-06T07:00:00.000Z")).map((job) => job.id), [due.id]);
  });
});

Deno.test("CronJobStore leases due jobs and prevents duplicate claims", async () => {
  await withStore(async (store) => {
    const job = await store.create(input);

    const first = await store.acquireLease(job.id, "2026-06-06T07:00:00.000Z", 60_000);
    const second = await store.acquireLease(job.id, "2026-06-06T07:00:01.000Z", 60_000);

    assertExists(first);
    assertEquals(second, undefined);
  });
});

Deno.test("CronJobStore completes run by moving due index", async () => {
  await withStore(async (store) => {
    const job = await store.create(input);
    await store.acquireLease(job.id, "2026-06-06T07:00:00.000Z", 60_000);

    const updated = await store.completeRun(job.id, {
      ranAt: "2026-06-06T07:00:00.000Z",
      nextRunAt: "2026-06-07T07:00:00.000Z",
    });

    assertEquals(updated?.lastRunAt, "2026-06-06T07:00:00.000Z");
    assertEquals(await store.listDue("2026-06-06T07:00:00.000Z"), []);
    assertEquals((await store.listDue("2026-06-07T07:00:00.000Z")).map((due) => due.id), [job.id]);
  });
});

Deno.test("CronJobStore failed run records error and moves due index", async () => {
  await withStore(async (store) => {
    const job = await store.create(input);
    await store.acquireLease(job.id, "2026-06-06T07:00:00.000Z", 60_000);

    const updated = await store.failRun(job.id, {
      failedAt: "2026-06-06T07:00:00.000Z",
      nextRunAt: "2026-06-07T07:00:00.000Z",
      error: "permission denied",
    });

    assertEquals(updated?.lastFailedAt, "2026-06-06T07:00:00.000Z");
    assertEquals(updated?.lastError, "permission denied");
    assertEquals(await store.listDue("2026-06-06T07:00:00.000Z"), []);
    assertEquals((await store.listDue("2026-06-07T07:00:00.000Z")).map((due) => due.id), [job.id]);
  });
});
