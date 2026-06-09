import { assertEquals } from "jsr:@std/assert@1";

import { completeCronRunSchedule } from "../../src/app/cron-work.ts";
import { recoverInterruptedModelOutputs } from "../../src/app/model-output-recovery.ts";
import { cronRunWorkPayload } from "../../src/app/work-payload.ts";
import { EgressOutbox } from "../../src/core/mod.ts";
import { CronJobStore } from "../../src/cron/mod.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

function userTurnPayload(): unknown {
  return {
    input: {
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    },
    telegram: {
      chatId: 123,
      threadId: 9,
      replyToMessageId: 7,
      updateId: 99,
    },
  };
}

function assistantMessage(text: string): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function dueAvailableAt(): Date {
  return new Date("2026-06-08T09:00:00.000Z");
}

Deno.test("recoverInterruptedModelOutputs queues egress from persisted model messages and completes work", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const outbox = new EgressOutbox(events);
  const work = await queue.submit({
    kind: "user_turn",
    sessionId: "session-1",
    payload: userTurnPayload(),
    availableAt: dueAvailableAt(),
  });
  await events.append({
    category: "model.message",
    workId: work.id,
    sessionId: work.sessionId,
    payload: { message: assistantMessage("Recovered reply") },
  });

  const result = await recoverInterruptedModelOutputs({
    events,
    queue,
    outbox,
    ownerId: "recovery",
    now: () => new Date("2026-06-08T10:00:00.000Z"),
  });

  assertEquals(result, {
    candidates: 1,
    recovered: 1,
    skipped: 0,
    queuedEgress: 1,
    completedWorkIds: [work.id],
  });
  assertEquals((await queue.get(work.id))?.status, "completed");
  const pendingEgress = await outbox.listPending();
  assertEquals(pendingEgress.length, 1);
  assertEquals(pendingEgress[0]?.payload.replies, ["Recovered reply"]);
  assertEquals(pendingEgress[0]?.payload.target, {
    chatId: 123,
    threadId: 9,
    replyToMessageId: 7,
    updateId: 99,
  });
});

Deno.test("recoverInterruptedModelOutputs completes queued work that already has pending egress", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const outbox = new EgressOutbox(events);
  const work = await queue.submit({
    kind: "user_turn",
    sessionId: "session-1",
    payload: userTurnPayload(),
    availableAt: dueAvailableAt(),
  });
  await events.append({
    category: "model.message",
    workId: work.id,
    sessionId: work.sessionId,
    payload: { message: assistantMessage("Already queued") },
  });
  await outbox.queue({
    workId: work.id,
    sessionId: work.sessionId,
    target: { chatId: 123, replyToMessageId: 7 },
    replies: ["Already queued"],
    egressId: "existing-egress",
  });

  const result = await recoverInterruptedModelOutputs({
    events,
    queue,
    outbox,
    ownerId: "recovery",
    now: () => new Date("2026-06-08T10:00:00.000Z"),
  });

  assertEquals(result.queuedEgress, 0);
  assertEquals(result.recovered, 1);
  assertEquals((await queue.get(work.id))?.status, "completed");
  assertEquals((await outbox.listPending()).map((pending) => pending.payload.egressId), ["existing-egress"]);
});

Deno.test("recoverInterruptedModelOutputs skips active leased work", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const outbox = new EgressOutbox(events);
  const work = await queue.submit({
    kind: "user_turn",
    sessionId: "session-1",
    payload: userTurnPayload(),
    availableAt: dueAvailableAt(),
  });
  const leased = await queue.lease(work.id, {
    ownerId: "active-host",
    kinds: ["user_turn"],
  });
  if (!leased) throw new Error("Expected work lease");
  await events.append({
    category: "model.message",
    workId: work.id,
    sessionId: work.sessionId,
    payload: { message: assistantMessage("Do not recover") },
  });

  const result = await recoverInterruptedModelOutputs({
    events,
    queue,
    outbox,
    ownerId: "recovery",
  });

  assertEquals(result, {
    candidates: 1,
    recovered: 0,
    skipped: 1,
    queuedEgress: 0,
    completedWorkIds: [],
  });
  assertEquals((await queue.get(work.id))?.status, "leased");
  assertEquals(await outbox.listPending(), []);
});

Deno.test("recoverInterruptedModelOutputs advances cron schedules before completing recovered work", async () => {
  const kv = await Deno.openKv(":memory:");
  try {
    const cronStore = new CronJobStore(kv);
    const job = await cronStore.create({
      chatId: 123,
      threadId: 9,
      prompt: "Check daily status.",
      schedule: {
        kind: "recurring",
        scheduleText: "Every morning at 8am",
        timezone: "Europe/London",
        cronExpression: "0 8 * * *",
        recurrence: { kind: "daily", hour: 8, minute: 0 },
      },
      nextRunAt: "2026-06-06T07:00:00.000Z",
      sessionMode: "fresh",
      permissionProfile: { toolRules: [], brokerRules: [] },
      topicName: "Cron: daily",
    });
    const events = new MemoryKernelStore();
    const queue = events;
    const outbox = new EgressOutbox(events);
    const work = await queue.submit({
      kind: "cron_run",
      sessionId: "session-1",
      availableAt: new Date("2026-06-06T07:00:03.000Z"),
      payload: {
        input: {
          message: {
            role: "user",
            content: [{ type: "text", text: job.prompt }],
          },
        },
        prompt: job.prompt,
        cron: {
          jobId: job.id,
          topicName: job.topicName,
          sessionMode: job.sessionMode,
          dueAt: job.nextRunAt,
          dispatchedAt: "2026-06-06T07:00:03.000Z",
        },
        telegram: {
          chatId: job.chatId,
          threadId: job.threadId,
          replyToMessageId: 7,
          cronJobId: job.id,
        },
      },
    });
    await events.append({
      category: "model.message",
      workId: work.id,
      sessionId: work.sessionId,
      payload: { message: assistantMessage("Recovered cron reply") },
    });
    const statusesDuringHook: string[] = [];

    const result = await recoverInterruptedModelOutputs({
      events,
      queue,
      outbox,
      ownerId: "recovery",
      now: () => new Date("2026-06-08T10:00:00.000Z"),
      onRecoveredWork: async (recoveredWork) => {
        statusesDuringHook.push((await queue.get(recoveredWork.id))?.status ?? "missing");
        const payload = cronRunWorkPayload(recoveredWork.payload);
        const currentJob = await cronStore.get(payload.cron.jobId);
        if (!currentJob) throw new Error("Expected cron job");
        await completeCronRunSchedule(cronStore, currentJob, payload);
      },
    });

    assertEquals(result.recovered, 1);
    assertEquals(statusesDuringHook, ["leased"]);
    assertEquals((await queue.get(work.id))?.status, "completed");
    const updated = await cronStore.get(job.id);
    assertEquals(updated?.lastRunAt, "2026-06-06T07:00:03.000Z");
    assertEquals(updated?.nextRunAt, "2026-06-07T07:00:00.000Z");
    assertEquals(await cronStore.listDue("2026-06-06T07:00:03.000Z"), []);
    assertEquals((await outbox.listPending())[0]?.payload.replies, ["Recovered cron reply"]);
  } finally {
    kv.close();
  }
});
