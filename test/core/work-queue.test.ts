import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

import { MemoryEventStore, MemoryWorkQueue } from "../../src/core/mod.ts";

function categories(events: MemoryEventStore, workId: string): Promise<string[]> {
  return events.listByWork(workId).then((items) => items.map((event) => event.category));
}

Deno.test("MemoryWorkQueue uses shared lifecycle behavior for lease, release, fail, cancel, and recovery", async () => {
  const events = new MemoryEventStore();
  const queue = new MemoryWorkQueue(events);

  const work = await queue.submit({
    id: "work-release-fail",
    kind: "user_turn",
    sessionId: "session-1",
    payload: { input: { text: "hello" } },
    availableAt: new Date("2026-06-08T09:00:00.000Z"),
  });
  await assertRejects(
    () =>
      queue.submit({
        id: work.id,
        kind: "user_turn",
        sessionId: "session-1",
        payload: {},
      }),
    Error,
    "Work item already exists: work-release-fail",
  );
  assertEquals(
    await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["maintenance"],
      now: new Date("2026-06-08T09:00:00.000Z"),
    }),
    null,
  );
  assertEquals(
    await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
      now: new Date("2026-06-08T08:59:59.999Z"),
    }),
    null,
  );

  const leased = await queue.lease(work.id, {
    ownerId: "host-a",
    kinds: ["user_turn"],
    now: new Date("2026-06-08T09:00:00.000Z"),
  });
  assert(leased);
  assertEquals(leased.status, "leased");
  assertEquals(leased.attempts, 1);

  await queue.release(work.id, {
    leaseId: leased.lease.id,
    now: new Date("2026-06-08T09:01:00.000Z"),
    availableAt: new Date("2026-06-08T09:05:00.000Z"),
  });
  assertEquals((await queue.get(work.id))?.status, "queued");
  assertEquals(
    await queue.leaseNext({
      ownerId: "host-b",
      now: new Date("2026-06-08T09:04:59.999Z"),
    }),
    null,
  );

  const leasedAgain = await queue.leaseNext({
    ownerId: "host-b",
    now: new Date("2026-06-08T09:05:00.000Z"),
  });
  assert(leasedAgain);
  assertEquals(leasedAgain.id, work.id);
  assertEquals(leasedAgain.attempts, 2);
  await queue.fail(work.id, {
    leaseId: leasedAgain.lease.id,
    now: new Date("2026-06-08T09:06:00.000Z"),
    reason: "boom",
  });
  assertEquals((await queue.get(work.id))?.status, "failed");
  assertEquals(await categories(events, work.id), [
    "work.created",
    "work.leased",
    "work.leased",
    "work.failed",
  ]);

  const cancelled = await queue.submit({
    id: "work-cancel",
    kind: "maintenance",
    sessionId: "session-1",
    payload: {},
  });
  await queue.cancel(cancelled.id, {
    reason: "not needed",
    now: new Date("2026-06-08T09:07:00.000Z"),
  });
  await queue.cancel(cancelled.id, {
    reason: "already terminal",
    now: new Date("2026-06-08T09:08:00.000Z"),
  });
  assertEquals((await queue.get(cancelled.id))?.status, "cancelled");
  assertEquals(await categories(events, cancelled.id), ["work.created", "work.cancelled"]);

  const recovered = await queue.submit({
    id: "work-recover-requeue",
    kind: "maintenance",
    sessionId: "session-1",
    payload: {},
    availableAt: new Date("2026-06-08T09:00:00.000Z"),
  });
  const leasedRecovered = await queue.lease(recovered.id, {
    ownerId: "host-c",
    now: new Date("2026-06-08T09:09:00.000Z"),
  });
  assert(leasedRecovered);
  assertEquals(
    await queue.recoverInterruptedWork({
      now: new Date("2026-06-08T09:10:00.000Z"),
      maxAttempts: 3,
    }),
    { requeued: [recovered.id], failed: [] },
  );
  assertEquals((await queue.get(recovered.id))?.status, "queued");
  assertEquals(await categories(events, recovered.id), ["work.created", "work.leased"]);

  const exhausted = await queue.submit({
    id: "work-recover-fail",
    kind: "maintenance",
    sessionId: "session-1",
    payload: {},
    availableAt: new Date("2026-06-08T09:00:00.000Z"),
  });
  const leasedExhausted = await queue.lease(exhausted.id, {
    ownerId: "host-c",
    now: new Date("2026-06-08T09:11:00.000Z"),
  });
  assert(leasedExhausted);
  assertEquals(
    await queue.recoverInterruptedWork({
      now: new Date("2026-06-08T09:12:00.000Z"),
      maxAttempts: 1,
    }),
    { requeued: [], failed: [exhausted.id] },
  );
  assertEquals((await queue.get(exhausted.id))?.status, "failed");
  assertEquals(await categories(events, exhausted.id), ["work.created", "work.leased", "work.failed"]);
});
