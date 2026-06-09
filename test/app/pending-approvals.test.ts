import { assertEquals } from "jsr:@std/assert@1";

import { recoverTelegramPendingCapabilities } from "../../src/app/pending-approvals.ts";
import {
  type CapabilityDescriptor,
  EgressOutbox,
  listPendingCapabilities,
  MemoryKernelStore,
} from "../../src/core/mod.ts";

const capability: CapabilityDescriptor = {
  kind: "local_tool",
  target: "MEMORY.md",
  action: "write",
};

function userTurnPayload(): unknown {
  return {
    input: {
      message: {
        role: "user",
        content: [{ type: "text", text: "update memory" }],
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

Deno.test("recoverTelegramPendingCapabilities cancels orphaned capability work and queues Telegram notice", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const outbox = new EgressOutbox(events);
  const work = await queue.submit({
    kind: "user_turn",
    sessionId: "session-1",
    payload: userTurnPayload(),
  });
  await events.append({
    category: "approval.requested",
    workId: work.id,
    sessionId: work.sessionId,
    payload: {
      capability,
      request: {
        operation: "write",
        target: "MEMORY.md",
        risk: "medium",
        sessionId: work.sessionId,
        turnId: work.id,
        timeoutMs: 1000,
      },
    },
  });

  const result = await recoverTelegramPendingCapabilities({
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
    cancelledWorkIds: [work.id],
  });
  assertEquals((await queue.get(work.id))?.status, "cancelled");
  assertEquals(await listPendingCapabilities(events), []);
  const pendingEgress = await outbox.listPending();
  assertEquals(pendingEgress.length, 1);
  assertEquals(pendingEgress[0]?.payload.target, {
    chatId: 123,
    threadId: 9,
    replyToMessageId: 7,
    updateId: 99,
  });
  assertEquals(pendingEgress[0]?.payload.fallbackText?.includes("restarted while waiting for approval"), true);
});

Deno.test("recoverTelegramPendingCapabilities skips capabilities without recoverable work", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const outbox = new EgressOutbox(events);
  await events.append({
    category: "approval.requested",
    sessionId: "session-1",
    payload: { capability, request: { target: "MEMORY.md" } },
  });

  const result = await recoverTelegramPendingCapabilities({
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
    cancelledWorkIds: [],
  });
  assertEquals((await listPendingCapabilities(events)).length, 1);
  assertEquals(await outbox.listPending(), []);
});
