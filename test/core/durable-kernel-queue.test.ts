import { assert, assertEquals } from "jsr:@std/assert@1";

import { KvKernelStore, WorkspaceGate } from "../../src/core/mod.ts";
import { withKv } from "./durable-kernel-fixtures.ts";

Deno.test("KvKernelStore leases, completes, and recovers interrupted work durably", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "hello" } },
      availableAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const leased = await queue.leaseNext({
      ownerId: "host-a",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert(leased);
    assertEquals(leased.id, work.id);
    assertEquals(leased.status, "leased");
    assertEquals(leased.attempts, 1);
    assertEquals(
      await queue.leaseNext({
        ownerId: "host-b",
        now: new Date("2026-01-01T00:00:00.100Z"),
      }),
      null,
    );

    const recovered = await queue.recoverInterruptedWork({
      now: new Date("2026-01-01T00:00:00.100Z"),
      maxAttempts: 3,
    });
    assertEquals(recovered.requeued, [work.id]);
    assertEquals(recovered.failed, []);

    const leasedAgain = await queue.leaseNext({
      ownerId: "host-b",
      now: new Date("2026-01-01T00:00:02.000Z"),
    });
    assert(leasedAgain);
    assertEquals(leasedAgain.attempts, 2);

    await queue.complete(leasedAgain.id, {
      leaseId: leasedAgain.lease.id,
      now: new Date("2026-01-01T00:00:02.100Z"),
    });

    assertEquals((await queue.get(leasedAgain.id))?.status, "completed");
    assertEquals((await events.listBySession(work.sessionId)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "work.released",
      "work.leased",
      "work.completed",
    ]);
  });
});

Deno.test("KvKernelStore leases a specific submitted work item", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const first = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "first" } },
    });
    const second = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "second" } },
    });

    const leasedSecond = await queue.lease(second.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });

    assert(leasedSecond);
    assertEquals(leasedSecond.id, second.id);
    assertEquals((await queue.get(first.id))?.status, "queued");
    assertEquals((await queue.get(second.id))?.status, "leased");
  });
});

Deno.test("WorkspaceGate serializes in-process workspace turns", async () => {
  const gate = new WorkspaceGate();
  const order: string[] = [];
  const releaseFirst = Promise.withResolvers<void>();
  const firstEntered = Promise.withResolvers<void>();

  const first = gate.runExclusive("first", new AbortController().signal, async () => {
    order.push("first:start");
    firstEntered.resolve();
    await releaseFirst.promise;
    order.push("first:end");
  });
  await firstEntered.promise;

  const second = gate.runExclusive("second", new AbortController().signal, () => {
    order.push("second");
    return Promise.resolve();
  });
  await Promise.resolve();
  assertEquals(order, ["first:start"]);

  releaseFirst.resolve();
  await first;
  await second;
  assertEquals(order, ["first:start", "first:end", "second"]);
});
