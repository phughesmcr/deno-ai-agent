import { assertEquals } from "jsr:@std/assert@1";

import { completeCronRunSchedule, failCronRunSchedule, submitCronRunWork } from "../../src/app/cron-work.ts";
import { cronRunWorkPayload } from "../../src/app/work-payload.ts";
import { CapabilityLedger, KvKernelStore } from "../../src/core/mod.ts";
import { type CronJob, CronJobStore } from "../../src/cron/mod.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

const job: CronJob = {
  id: "cron-a",
  chatId: 123,
  threadId: 99,
  prompt: "Check Gmail and summarize actions.",
  schedule: {
    kind: "recurring",
    scheduleText: "Every morning at 8am",
    timezone: "Europe/London",
    cronExpression: "0 8 * * *",
    recurrence: { kind: "daily", hour: 8, minute: 0 },
  },
  nextRunAt: "2026-06-06T07:00:00.000Z",
  enabled: true,
  sessionMode: "fresh",
  permissionProfile: { toolRules: [], brokerRules: [] },
  createdAt: "2026-06-05T12:00:00.000Z",
  updatedAt: "2026-06-05T12:00:00.000Z",
  topicName: "Cron: daily",
};

function createQueue(): MemoryKernelStore {
  return new MemoryKernelStore();
}

async function withCronStore(fn: (store: CronJobStore) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(new CronJobStore(kv));
  } finally {
    kv.close();
  }
}

Deno.test("submitCronRunWork creates deterministic durable cron work with serialized model input", async () => {
  const queue = createQueue();

  const result = await submitCronRunWork({
    queue,
    job,
    sessionId: "session-1",
    replyToMessageId: 7,
    dispatchedAt: new Date("2026-06-06T07:00:03.000Z"),
  });

  assertEquals(result, { status: "submitted", workId: "cron:cron-a:2026-06-06T07:00:00.000Z" });
  const work = await queue.get(result.workId);
  assertEquals(work?.kind, "cron_run");
  assertEquals(work?.sessionId, "session-1");
  const payload = cronRunWorkPayload(work?.payload);
  assertEquals(payload.prompt, job.prompt);
  assertEquals(payload.input.message.role, "user");
  assertEquals(payload.telegram, {
    chatId: 123,
    threadId: 99,
    replyToMessageId: 7,
    cronJobId: "cron-a",
  });
  assertEquals(payload.cron, {
    jobId: "cron-a",
    topicName: "Cron: daily",
    sessionMode: "fresh",
    dueAt: "2026-06-06T07:00:00.000Z",
    dispatchedAt: "2026-06-06T07:00:03.000Z",
  });
});

Deno.test("submitCronRunWork records the cron profile decision in the capability ledger", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const events = new KvKernelStore(kv);
    const queue = events;
    const capabilityLedger = new CapabilityLedger({ kv, events });

    const result = await submitCronRunWork({
      queue,
      job,
      sessionId: "session-1",
      dispatchedAt: new Date("2026-06-06T07:00:03.000Z"),
      capabilityLedger,
    });

    assertEquals(result, { status: "submitted", workId: "cron:cron-a:2026-06-06T07:00:00.000Z" });
    assertEquals(
      (await capabilityLedger.authorize({
        sessionId: "session-1",
        capability: { kind: "cron_profile", target: "cron-a", action: "run" },
      })).state,
      "allowed",
    );
    assertEquals((await events.listByWork(result.workId)).map((event) => event.category), [
      "work.created",
      "approval.decided",
    ]);
    assertEquals(cronRunWorkPayload((await queue.get(result.workId))?.payload).telegram, {
      chatId: 123,
      threadId: 99,
      cronJobId: "cron-a",
    });
  } finally {
    kv.close();
  }
});

Deno.test("submitCronRunWork treats existing queued cron work as already submitted", async () => {
  const queue = createQueue();

  const first = await submitCronRunWork({
    queue,
    job,
    sessionId: "session-1",
    replyToMessageId: 7,
    dispatchedAt: new Date("2026-06-06T07:00:03.000Z"),
  });
  const second = await submitCronRunWork({
    queue,
    job,
    sessionId: "session-1",
    replyToMessageId: 8,
    dispatchedAt: new Date("2026-06-06T07:00:04.000Z"),
  });

  assertEquals(second, first);
  assertEquals((await queue.get(first.workId))?.payload, (await queue.get(second.workId))?.payload);
});

Deno.test("submitCronRunWork reports existing terminal cron work", async () => {
  const queue = createQueue();
  const submitted = await submitCronRunWork({
    queue,
    job,
    sessionId: "session-1",
    replyToMessageId: 7,
    dispatchedAt: new Date("2026-06-06T07:00:03.000Z"),
  });
  const leased = await queue.lease(submitted.workId, {
    ownerId: "test",
    kinds: ["cron_run"],
  });
  if (!leased) throw new Error("Expected cron work lease");
  await queue.complete(leased.id, { leaseId: leased.lease.id });

  const result = await submitCronRunWork({
    queue,
    job,
    sessionId: "session-1",
    replyToMessageId: 8,
    dispatchedAt: new Date("2026-06-06T07:00:04.000Z"),
  });

  assertEquals(result, { status: "completed", workId: submitted.workId });
});

Deno.test("completeCronRunSchedule advances recurring cron jobs from dispatchedAt", async () => {
  await withCronStore(async (store) => {
    const created = await store.create(job);
    const queue = createQueue();
    const submitted = await submitCronRunWork({
      queue,
      job: created,
      sessionId: "session-1",
      replyToMessageId: 7,
      dispatchedAt: new Date("2026-06-06T07:00:03.000Z"),
    });
    const payload = cronRunWorkPayload((await queue.get(submitted.workId))?.payload);

    await completeCronRunSchedule(store, created, payload);

    const updated = await store.get(created.id);
    assertEquals(updated?.lastRunAt, "2026-06-06T07:00:03.000Z");
    assertEquals(updated?.nextRunAt, "2026-06-07T07:00:00.000Z");
    assertEquals(await store.listDue("2026-06-06T07:00:03.000Z"), []);
    assertEquals((await store.listDue("2026-06-07T07:00:00.000Z")).map((due) => due.id), [created.id]);
  });
});

Deno.test("failCronRunSchedule disables failed one-shot cron jobs", async () => {
  await withCronStore(async (store) => {
    const oneShot = await store.create({
      ...job,
      schedule: {
        kind: "once",
        scheduleText: "next Tuesday",
        timezone: "Europe/London",
        runAt: "2026-06-09T09:00:00.000Z",
      },
      nextRunAt: "2026-06-09T09:00:00.000Z",
    });
    const queue = createQueue();
    const submitted = await submitCronRunWork({
      queue,
      job: oneShot,
      sessionId: "session-1",
      replyToMessageId: 7,
      dispatchedAt: new Date("2026-06-09T09:00:02.000Z"),
    });
    const payload = cronRunWorkPayload((await queue.get(submitted.workId))?.payload);

    await failCronRunSchedule(store, oneShot, payload, "model failed");

    const updated = await store.get(oneShot.id);
    assertEquals(updated?.enabled, false);
    assertEquals(updated?.lastFailedAt, "2026-06-09T09:00:02.000Z");
    assertEquals(updated?.lastError, "model failed");
    assertEquals(await store.listDue("2026-06-09T09:00:02.000Z"), []);
  });
});
