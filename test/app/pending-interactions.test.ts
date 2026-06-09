import { assertEquals } from "jsr:@std/assert@1";

import { recoverTelegramPendingInteractions } from "../../src/app/pending-interactions.ts";
import { EgressOutbox, listPendingInteractions } from "../../src/core/mod.ts";
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

function dueAvailableAt(): Date {
  return new Date("2026-06-08T09:00:00.000Z");
}

Deno.test("recoverTelegramPendingInteractions keeps orphaned work queued and queues Telegram notice", async () => {
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
    category: "interaction.requested",
    workId: work.id,
    sessionId: work.sessionId,
    payload: {
      interactionId: "interaction-1",
      request: {
        mode: "cursor_questions",
        questions: [{
          question: "Continue?",
          header: "Continue",
          options: [
            { label: "Yes", description: "Continue" },
            { label: "No", description: "Stop" },
          ],
        }],
      },
      requestedAt: "2026-06-08T09:00:00.000Z",
    },
  });

  const result = await recoverTelegramPendingInteractions({
    events,
    queue,
    outbox,
    now: () => new Date("2026-06-08T09:05:00.000Z"),
  });

  assertEquals(result, {
    pending: 1,
    recovered: 1,
    skipped: 0,
    notified: 1,
    requeuedWorkIds: [],
  });
  assertEquals((await queue.get(work.id))?.status, "queued");
  assertEquals(await listPendingInteractions(events), []);
  const pendingEgress = await outbox.listPending();
  assertEquals(pendingEgress.length, 1);
  assertEquals(pendingEgress[0]?.payload.target, {
    chatId: 123,
    threadId: 9,
    replyToMessageId: 7,
    updateId: 99,
  });
  assertEquals(pendingEgress[0]?.payload.fallbackText?.includes("restarted while waiting"), true);
  assertEquals(pendingEgress[0]?.payload.fallbackText?.includes("queued the interrupted turn again"), true);
});

Deno.test("recoverTelegramPendingInteractions requeues still-leased orphaned work", async () => {
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
    ownerId: "stale-host",
    kinds: ["user_turn"],
    now: new Date("2026-06-08T09:00:00.000Z"),
  });
  await events.append({
    category: "interaction.requested",
    workId: work.id,
    sessionId: work.sessionId,
    payload: {
      interactionId: "interaction-1",
      request: {
        mode: "cursor_questions",
        questions: [{
          question: "Continue?",
          header: "Continue",
          options: [
            { label: "Yes", description: "Continue" },
            { label: "No", description: "Stop" },
          ],
        }],
      },
      requestedAt: "2026-06-08T09:00:00.000Z",
    },
  });

  const result = await recoverTelegramPendingInteractions({
    events,
    queue,
    outbox,
    now: () => new Date("2026-06-08T09:05:00.000Z"),
  });

  assertEquals(result.requeuedWorkIds, [work.id]);
  assertEquals((await queue.get(work.id))?.status, "queued");
  assertEquals((await queue.get(work.id))?.lease, undefined);
  assertEquals(leased?.id, work.id);
});

Deno.test("recoverTelegramPendingInteractions skips pending interactions without recoverable work", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const outbox = new EgressOutbox(events);
  await events.append({
    category: "interaction.requested",
    sessionId: "session-1",
    payload: {
      interactionId: "interaction-without-work",
      request: { mode: "cursor_questions", questions: [] },
      requestedAt: "2026-06-08T09:00:00.000Z",
    },
  });

  const result = await recoverTelegramPendingInteractions({
    events,
    queue,
    outbox,
    now: () => new Date("2026-06-08T09:05:00.000Z"),
  });

  assertEquals(result, {
    pending: 1,
    recovered: 0,
    skipped: 1,
    notified: 0,
    requeuedWorkIds: [],
  });
  assertEquals((await listPendingInteractions(events)).map((pending) => pending.interactionId), [
    "interaction-without-work",
  ]);
  assertEquals(await outbox.listPending(), []);
});
