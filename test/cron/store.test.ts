import { assertEquals, assertExists } from "jsr:@std/assert@1";

import { type CreateCronJobInput, CronJobStore } from "../../src/cron/store.ts";

const input: CreateCronJobInput = {
  chatId: 1,
  prompt: "Check Gmail and summarize actions.",
  schedule: {
    kind: "recurring",
    scheduleText: "Every morning at 8am",
    timezone: "Europe/London",
    cronExpression: "0 8 * * *",
    recurrence: { kind: "daily", hour: 8, minute: 0 },
  },
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
    assertEquals(listed[0]?.sessionMode, "fresh");

    await store.delete(created.id);
    assertEquals(await store.listForChat(1), []);
  });
});

Deno.test("CronJobStore updates session mode", async () => {
  await withStore(async (store) => {
    const created = await store.create(input);

    const updated = await store.setSessionMode(created.id, "persistent");

    assertEquals(updated?.sessionMode, "persistent");
    assertEquals((await store.get(created.id))?.sessionMode, "persistent");
  });
});

Deno.test("CronJobStore adds permission rules without duplicating existing rules", async () => {
  await withStore(async (store) => {
    const created = await store.create(input);

    const updated = await store.addPermissionRules(created.id, {
      toolRules: [
        { operation: "mcp", target: "gmail/search" },
        { operation: "write", target: "MEMORY.md" },
      ],
      brokerRules: [
        { permission: "run", value: "/bin/zsh" },
        { permission: "run", value: "/bin/zsh" },
      ],
    });

    assertEquals(updated?.permissionProfile.toolRules, [
      { operation: "mcp", target: "gmail/search" },
      { operation: "write", target: "MEMORY.md" },
    ]);
    assertEquals(updated?.permissionProfile.brokerRules, [{ permission: "run", value: "/bin/zsh" }]);
    assertEquals((await store.get(created.id))?.permissionProfile, updated?.permissionProfile);
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

Deno.test("CronJobStore deletes successful one-shot jobs", async () => {
  await withStore(async (store) => {
    const job = await store.create({
      ...input,
      schedule: {
        kind: "once",
        scheduleText: "next Tuesday",
        timezone: "Europe/London",
        runAt: "2026-06-09T09:00:00.000Z",
      },
      nextRunAt: "2026-06-09T09:00:00.000Z",
    });
    await store.acquireLease(job.id, "2026-06-09T09:00:00.000Z", 60_000);

    const deleted = await store.completeOneShotRun(job.id, { ranAt: "2026-06-09T09:00:00.000Z" });

    assertEquals(deleted?.lastRunAt, "2026-06-09T09:00:00.000Z");
    assertEquals(await store.get(job.id), undefined);
    assertEquals(await store.listDue("2026-06-09T09:00:00.000Z"), []);
    assertEquals(await store.listForChat(1), []);
  });
});

Deno.test("CronJobStore disables failed one-shot jobs and removes them from due list", async () => {
  await withStore(async (store) => {
    const job = await store.create({
      ...input,
      schedule: {
        kind: "once",
        scheduleText: "next Tuesday",
        timezone: "Europe/London",
        runAt: "2026-06-09T09:00:00.000Z",
      },
      nextRunAt: "2026-06-09T09:00:00.000Z",
    });
    await store.acquireLease(job.id, "2026-06-09T09:00:00.000Z", 60_000);

    const updated = await store.failOneShotRun(job.id, {
      failedAt: "2026-06-09T09:00:00.000Z",
      error: "permission denied",
    });

    assertEquals(updated?.enabled, false);
    assertEquals(updated?.lastFailedAt, "2026-06-09T09:00:00.000Z");
    assertEquals(updated?.lastError, "permission denied");
    assertEquals(await store.listDue("2026-06-09T09:00:00.000Z"), []);
    assertEquals((await store.listForChat(1)).map((listed) => listed.id), [job.id]);
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
