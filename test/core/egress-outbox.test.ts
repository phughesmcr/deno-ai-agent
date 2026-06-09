import { assertEquals } from "jsr:@std/assert@1";

import { EgressOutbox } from "../../src/core/mod.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

Deno.test("EgressOutbox queues egress and hides it after sent", async () => {
  const events = new MemoryKernelStore();
  const outbox = new EgressOutbox(events);

  const queued = await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "egress-1",
    target: { chatId: 123 },
    replies: ["hello"],
    now: new Date("2026-01-01T00:00:00.000Z"),
  });

  assertEquals(await outbox.listPending(), [{ event: queued.event, payload: queued.payload }]);

  await outbox.markSent({
    workId: "work-1",
    sessionId: "session-1",
    payload: queued.payload,
    now: new Date("2026-01-01T00:00:01.000Z"),
  });

  assertEquals(await outbox.listPending(), []);
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
    "egress.queued",
    "egress.sent",
  ]);
});

Deno.test("EgressOutbox hides permanently dropped egress", async () => {
  const events = new MemoryKernelStore();
  const outbox = new EgressOutbox(events);

  const queued = await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "egress-1",
    target: { chatId: 123 },
    replies: ["hello"],
  });
  await outbox.markDropped({
    workId: "work-1",
    sessionId: "session-1",
    payload: queued.payload,
    reason: "message thread not found",
  });

  assertEquals(await outbox.listPending(), []);
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
    "egress.queued",
    "egress.dropped",
  ]);
});

Deno.test("EgressOutbox replays pending egress by session and work", async () => {
  const events = new MemoryKernelStore();
  const outbox = new EgressOutbox(events);
  const first = await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "egress-1",
    target: { chatId: 1 },
    replies: [],
    fallbackText: "no reply",
  });
  const second = await outbox.queue({
    workId: "work-2",
    sessionId: "session-1",
    egressId: "egress-2",
    target: { chatId: 2 },
    replies: ["second"],
  });
  await outbox.markSent({ workId: "work-1", sessionId: "session-1", payload: first.payload });

  const restarted = new EgressOutbox(events);
  assertEquals((await restarted.listPending({ sessionId: "session-1" })).map((pending) => pending.payload.egressId), [
    "egress-2",
  ]);
  assertEquals(await restarted.listPending({ workId: "work-1" }), []);
  assertEquals((await restarted.listPending({ workId: "work-2" })).map((pending) => pending.event.id), [
    second.event.id,
  ]);
});

Deno.test("EgressOutbox scopes sent matching by work and session as well as egress id", async () => {
  const events = new MemoryKernelStore();
  const outbox = new EgressOutbox(events);
  const first = await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "deterministic-egress",
    target: { chatId: 1 },
    replies: ["first"],
  });
  const second = await outbox.queue({
    workId: "work-2",
    sessionId: "session-2",
    egressId: "deterministic-egress",
    target: { chatId: 2 },
    replies: ["second"],
  });

  await outbox.markSent({ workId: "work-1", sessionId: "session-1", payload: first.payload });

  assertEquals((await outbox.listPending()).map((pending) => pending.event.id), [second.event.id]);
  assertEquals((await outbox.listPending()).map((pending) => pending.payload.replies), [["second"]]);
});
