import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  assertMatchingWorkLease,
  cancelNonTerminalWork,
  checkWorkLeaseEligibility,
  completeLeasedWork,
  createQueuedWorkItem,
  failLeasedWork,
  isTerminalWorkStatus,
  leaseQueuedWork,
  recoverInterruptedLeasedWork,
  releaseLeasedWork,
} from "../../src/core/work_state.ts";
import type { LeasedWorkItem, WorkItem } from "../../src/core/work_queue.ts";

const CREATED_AT = new Date("2026-06-08T09:00:00.000Z");
const LEASED_AT = new Date("2026-06-08T09:05:00.000Z");
const UPDATED_AT = new Date("2026-06-08T09:10:00.000Z");

function queuedWork(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "work-1",
    kind: "user_turn",
    sessionId: "session-1",
    payload: { input: { text: "hello" } },
    status: "queued",
    createdAt: "2026-06-08T09:00:00.000Z",
    updatedAt: "2026-06-08T09:00:00.000Z",
    availableAt: "2026-06-08T09:00:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

function leasedWork(overrides: Partial<LeasedWorkItem> = {}): LeasedWorkItem {
  return {
    ...queuedWork(),
    status: "leased",
    updatedAt: "2026-06-08T09:05:00.000Z",
    attempts: 1,
    lease: {
      id: "lease-1",
      ownerId: "host-a",
      leasedAt: "2026-06-08T09:05:00.000Z",
    },
    ...overrides,
  };
}

Deno.test("createQueuedWorkItem creates queued work and work.created event with deterministic id/time", () => {
  const result = createQueuedWorkItem({
    kind: "user_turn",
    sessionId: "session-1",
    payload: { input: { text: "hello" } },
    availableAt: new Date("2026-06-08T09:30:00.000Z"),
  }, {
    id: "work-1",
    now: CREATED_AT,
  });

  assertEquals(result.item, {
    id: "work-1",
    kind: "user_turn",
    sessionId: "session-1",
    payload: { input: { text: "hello" } },
    status: "queued",
    createdAt: "2026-06-08T09:00:00.000Z",
    updatedAt: "2026-06-08T09:00:00.000Z",
    availableAt: "2026-06-08T09:30:00.000Z",
    attempts: 0,
  });
  assertEquals(result.event, {
    category: "work.created",
    workId: "work-1",
    sessionId: "session-1",
    payload: { kind: "user_turn", availableAt: "2026-06-08T09:30:00.000Z" },
  });
});

Deno.test("checkWorkLeaseEligibility accepts due queued work and rejects wrong kind, not-due, and non-queued work", () => {
  assertEquals(
    checkWorkLeaseEligibility(queuedWork(), {
      kinds: ["user_turn"],
      now: CREATED_AT,
    }),
    { eligible: true },
  );
  assertEquals(
    checkWorkLeaseEligibility(queuedWork({ kind: "maintenance" }), {
      kinds: ["user_turn"],
      now: CREATED_AT,
    }),
    { eligible: false, reason: "wrong_kind" },
  );
  assertEquals(
    checkWorkLeaseEligibility(queuedWork({ availableAt: "2026-06-08T09:00:01.000Z" }), {
      kinds: ["user_turn"],
      now: CREATED_AT,
    }),
    { eligible: false, reason: "not_due" },
  );
  assertEquals(
    checkWorkLeaseEligibility(queuedWork({ status: "completed" }), {
      kinds: ["user_turn"],
      now: CREATED_AT,
    }),
    { eligible: false, reason: "not_queued" },
  );
  assertEquals(
    checkWorkLeaseEligibility(null, {
      kinds: ["user_turn"],
      now: CREATED_AT,
    }),
    { eligible: false, reason: "missing" },
  );
});

Deno.test("leaseQueuedWork increments attempts, sets lease metadata, and emits work.leased", () => {
  const result = leaseQueuedWork(queuedWork(), {
    ownerId: "host-a",
    leaseId: "lease-1",
    kinds: ["user_turn"],
    now: LEASED_AT,
  });

  assertEquals(result.outcome, "leased");
  assert(result.outcome === "leased");
  assertEquals(result.item.status, "leased");
  assertEquals(result.item.attempts, 1);
  assertEquals(result.item.updatedAt, "2026-06-08T09:05:00.000Z");
  assertEquals(result.item.lease, {
    id: "lease-1",
    ownerId: "host-a",
    leasedAt: "2026-06-08T09:05:00.000Z",
  });
  assertEquals(result.event, {
    category: "work.leased",
    workId: "work-1",
    sessionId: "session-1",
    payload: { ownerId: "host-a", leaseId: "lease-1", attempts: 1 },
  });
  assertEquals(
    leaseQueuedWork(queuedWork({ kind: "maintenance" }), {
      ownerId: "host-a",
      leaseId: "lease-2",
      kinds: ["user_turn"],
      now: LEASED_AT,
    }),
    { outcome: "not_eligible", item: queuedWork({ kind: "maintenance" }), reason: "wrong_kind" },
  );
});

Deno.test("complete, release, and fail require a matching lease", () => {
  assertThrows(
    () => assertMatchingWorkLease(null, "lease-1"),
    Error,
    "Work item not found",
  );
  assertThrows(
    () => completeLeasedWork(queuedWork(), { leaseId: "lease-1", now: UPDATED_AT }),
    Error,
    "Work item is not leased",
  );
  assertThrows(
    () => releaseLeasedWork(leasedWork(), { leaseId: "other-lease", now: UPDATED_AT }),
    Error,
    "Work lease mismatch",
  );
  assertThrows(
    () => failLeasedWork(queuedWork(), { leaseId: "lease-1", now: UPDATED_AT, reason: "boom" }),
    Error,
    "Work item is not leased",
  );

  const completed = completeLeasedWork(leasedWork(), { leaseId: "lease-1", now: UPDATED_AT });
  assertEquals(completed.item.status, "completed");
  assertEquals(completed.item.lease, undefined);
  assertEquals(completed.event, {
    category: "work.completed",
    workId: "work-1",
    sessionId: "session-1",
    payload: {},
  });

  const released = releaseLeasedWork(leasedWork(), {
    leaseId: "lease-1",
    now: UPDATED_AT,
    availableAt: new Date("2026-06-08T09:30:00.000Z"),
  });
  assertEquals(released.item.status, "queued");
  assertEquals(released.item.lease, undefined);
  assertEquals(released.item.availableAt, "2026-06-08T09:30:00.000Z");
  assertEquals(released.event, {
    category: "work.released",
    workId: "work-1",
    sessionId: "session-1",
    payload: { availableAt: "2026-06-08T09:30:00.000Z" },
  });

  const failed = failLeasedWork(leasedWork(), { leaseId: "lease-1", now: UPDATED_AT, reason: "boom" });
  assertEquals(failed.item.status, "failed");
  assertEquals(failed.item.lease, undefined);
  assertEquals(failed.item.failure, "boom");
  assertEquals(failed.event, {
    category: "work.failed",
    workId: "work-1",
    sessionId: "session-1",
    payload: { reason: "boom" },
  });
});

Deno.test("cancelNonTerminalWork cancels queued and leased work and ignores terminal work", () => {
  const queued = cancelNonTerminalWork(queuedWork(), {
    reason: "no longer needed",
    now: UPDATED_AT,
  });
  assertEquals(queued.outcome, "cancelled");
  assert(queued.outcome === "cancelled");
  assertEquals(queued.item.status, "cancelled");
  assertEquals(queued.item.failure, "no longer needed");
  assertEquals(queued.event, {
    category: "work.cancelled",
    workId: "work-1",
    sessionId: "session-1",
    payload: { reason: "no longer needed" },
  });

  const leased = cancelNonTerminalWork(leasedWork(), {
    reason: "interrupted",
    now: UPDATED_AT,
  });
  assertEquals(leased.outcome, "cancelled");
  assert(leased.outcome === "cancelled");
  assertEquals(leased.item.lease, undefined);

  const terminal = cancelNonTerminalWork(queuedWork({ status: "failed", failure: "boom" }), {
    reason: "ignored",
    now: UPDATED_AT,
  });
  assertEquals(terminal, {
    outcome: "already_terminal",
    item: queuedWork({ status: "failed", failure: "boom" }),
  });
  assertEquals(isTerminalWorkStatus("completed"), true);
  assertEquals(isTerminalWorkStatus("leased"), false);
});

Deno.test("recoverInterruptedLeasedWork requeues interrupted work below max attempts", () => {
  const result = recoverInterruptedLeasedWork(leasedWork({ attempts: 2 }), {
    maxAttempts: 3,
    now: UPDATED_AT,
  });

  assertEquals(result.outcome, "requeued");
  assert(result.outcome === "requeued");
  assertEquals(result.item.status, "queued");
  assertEquals(result.item.availableAt, "2026-06-08T09:10:00.000Z");
  assertEquals(result.item.lease, undefined);
  assertEquals(result.event, {
    category: "work.released",
    workId: "work-1",
    sessionId: "session-1",
    payload: { availableAt: "2026-06-08T09:10:00.000Z" },
  });
});

Deno.test("recoverInterruptedLeasedWork fails interrupted work at max attempts", () => {
  const result = recoverInterruptedLeasedWork(leasedWork({ attempts: 3 }), {
    maxAttempts: 3,
    now: UPDATED_AT,
  });

  assertEquals(result.outcome, "failed");
  assert(result.outcome === "failed");
  assertEquals(result.item.status, "failed");
  assertEquals(result.item.failure, "interrupted work attempts exhausted");
  assertEquals(result.item.lease, undefined);
  assertEquals(result.event, {
    category: "work.failed",
    workId: "work-1",
    sessionId: "session-1",
    payload: { reason: "interrupted work attempts exhausted" },
  });
});
