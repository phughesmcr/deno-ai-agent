import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { runQueuedMaintenanceWork } from "../../src/app/maintenance-work.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

Deno.test("runQueuedMaintenanceWork completes leased maintenance work", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const work = await queue.submit({
    id: "maintenance-1",
    kind: "maintenance",
    sessionId: "session-a",
    payload: { task: "noop" },
    availableAt: new Date("2026-06-08T10:00:00.000Z"),
  });
  const leased = await queue.lease(work.id, {
    ownerId: "host-a",
    now: new Date("2026-06-08T10:00:00.000Z"),
  });
  if (!leased) throw new Error("Expected maintenance work to lease");

  await runQueuedMaintenanceWork({
    queue,
    work: leased,
    now: new Date("2026-06-08T10:00:01.000Z"),
  });

  assertEquals((await queue.get(work.id))?.status, "completed");
  assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
    "work.created",
    "work.leased",
    "work.completed",
  ]);
});

Deno.test("runQueuedMaintenanceWork rejects non-maintenance work", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const work = await queue.submit({
    id: "user-turn-1",
    kind: "user_turn",
    sessionId: "session-a",
    payload: {},
    availableAt: new Date("2026-06-08T10:00:00.000Z"),
  });
  const leased = await queue.lease(work.id, {
    ownerId: "host-a",
    now: new Date("2026-06-08T10:00:00.000Z"),
  });
  if (!leased) throw new Error("Expected user turn work to lease");

  await assertRejects(
    () => runQueuedMaintenanceWork({ queue, work: leased }),
    Error,
    "Expected maintenance work, got user_turn",
  );
  assertEquals((await queue.get(work.id))?.status, "leased");
});
