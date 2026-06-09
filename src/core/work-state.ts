import type { AppendEventInput } from "./events.ts";
import type { LeasedWorkItem, SubmitWorkInput, WorkItem, WorkKind, WorkStatus } from "./work-queue.ts";

/** Reason a work item cannot be leased. */
export type WorkLeaseIneligibilityReason = "missing" | "not_queued" | "not_due" | "wrong_kind";

/** Lease eligibility result for queued work. */
export type WorkLeaseEligibility =
  | { eligible: true }
  | { eligible: false; reason: WorkLeaseIneligibilityReason };

/** Result of creating queued work. */
export interface CreateQueuedWorkItemResult {
  /** Transition outcome. */
  outcome: "created";
  /** New queued work item. */
  item: WorkItem;
  /** Durable event to append. */
  event: AppendEventInput;
}

/** Options for deterministic queued-work creation. */
export interface CreateQueuedWorkItemOptions {
  /** Generated id to use when input does not provide one. */
  id: string;
  /** Current time. */
  now: Date;
}

/** Options for leasing queued work. */
export interface LeaseQueuedWorkOptions {
  /** Host/process requesting the lease. */
  ownerId: string;
  /** Stable generated lease id. */
  leaseId: string;
  /** Optional work kind filter. */
  kinds?: readonly WorkKind[];
  /** Current time. */
  now: Date;
}

/** Result of attempting to lease queued work. */
export type LeaseQueuedWorkResult =
  | {
    /** Transition outcome. */
    outcome: "leased";
    /** Updated leased work item. */
    item: LeasedWorkItem;
    /** Durable event to append. */
    event: AppendEventInput;
  }
  | {
    /** Transition outcome. */
    outcome: "not_eligible";
    /** Work item that was not eligible, when it existed. */
    item: WorkItem | null;
    /** Ineligibility reason. */
    reason: WorkLeaseIneligibilityReason;
  };

/** Options for completing leased work. */
export interface CompleteLeasedWorkOptions {
  /** Current lease id. */
  leaseId: string;
  /** Current time. */
  now: Date;
}

/** Result of completing leased work. */
export interface CompleteLeasedWorkResult {
  /** Transition outcome. */
  outcome: "completed";
  /** Updated terminal work item. */
  item: WorkItem;
  /** Durable event to append. */
  event: AppendEventInput;
}

/** Options for releasing leased work. */
export interface ReleaseLeasedWorkOptions extends CompleteLeasedWorkOptions {
  /** Earliest future lease time. Defaults to now. */
  availableAt?: Date;
}

/** Result of releasing leased work. */
export interface ReleaseLeasedWorkResult {
  /** Transition outcome. */
  outcome: "released";
  /** Updated queued work item. */
  item: WorkItem;
  /** Durable event to append. */
  event: AppendEventInput;
}

/** Options for failing leased work. */
export interface FailLeasedWorkOptions extends CompleteLeasedWorkOptions {
  /** Failure reason. */
  reason: string;
}

/** Result of failing leased work. */
export interface FailLeasedWorkResult {
  /** Transition outcome. */
  outcome: "failed";
  /** Updated terminal work item. */
  item: WorkItem;
  /** Durable event to append. */
  event: AppendEventInput;
}

/** Options for cancelling work. */
export interface CancelNonTerminalWorkOptions {
  /** Cancellation reason. */
  reason: string;
  /** Current time. */
  now: Date;
}

/** Result of cancelling work. */
export type CancelNonTerminalWorkResult =
  | {
    /** Transition outcome. */
    outcome: "cancelled";
    /** Updated terminal work item. */
    item: WorkItem;
    /** Durable event to append. */
    event: AppendEventInput;
  }
  | {
    /** Transition outcome. */
    outcome: "already_terminal";
    /** Unchanged terminal work item. */
    item: WorkItem;
    /** No durable event is emitted. */
    event?: undefined;
  };

/** Options for interrupted leased-work recovery. */
export interface RecoverInterruptedLeasedWorkOptions {
  /** Current time. */
  now: Date;
  /** Maximum lease attempts before failing a work item. */
  maxAttempts: number;
}

/** Interrupted leased-work recovery result. */
export type RecoverInterruptedLeasedWorkResult =
  | {
    /** Transition outcome. */
    outcome: "requeued";
    /** Updated queued work item. */
    item: WorkItem;
    /** Durable event to append. */
    event: AppendEventInput;
  }
  | {
    /** Transition outcome. */
    outcome: "failed";
    /** Updated terminal work item. */
    item: WorkItem;
    /** Durable event to append. */
    event: AppendEventInput;
  }
  | {
    /** Transition outcome. */
    outcome: "not_eligible";
    /** Work item that was not eligible, when it existed. */
    item: WorkItem | null;
    /** No durable event is emitted. */
    event?: undefined;
  };

const INTERRUPTED_WORK_FAILURE = "interrupted work attempts exhausted";

function iso(date: Date): string {
  return date.toISOString();
}

function matchesKind(kind: WorkKind, kinds: readonly WorkKind[] | undefined): boolean {
  return kinds === undefined || kinds.length === 0 || kinds.includes(kind);
}

function withoutLease(item: WorkItem): WorkItem {
  const { lease: _lease, ...rest } = item;
  return rest;
}

function createdEvent(item: WorkItem): AppendEventInput {
  return {
    category: "work.created",
    workId: item.id,
    sessionId: item.sessionId,
    payload: { kind: item.kind, availableAt: item.availableAt },
  };
}

function leasedEvent(item: LeasedWorkItem): AppendEventInput {
  return {
    category: "work.leased",
    workId: item.id,
    sessionId: item.sessionId,
    payload: {
      ownerId: item.lease.ownerId,
      leaseId: item.lease.id,
      attempts: item.attempts,
    },
  };
}

function completedEvent(item: WorkItem): AppendEventInput {
  return {
    category: "work.completed",
    workId: item.id,
    sessionId: item.sessionId,
    payload: {},
  };
}

function failedEvent(item: WorkItem, reason: string): AppendEventInput {
  return {
    category: "work.failed",
    workId: item.id,
    sessionId: item.sessionId,
    payload: { reason },
  };
}

function cancelledEvent(item: WorkItem, reason: string): AppendEventInput {
  return {
    category: "work.cancelled",
    workId: item.id,
    sessionId: item.sessionId,
    payload: { reason },
  };
}

function releasedEvent(item: WorkItem): AppendEventInput {
  return {
    category: "work.released",
    workId: item.id,
    sessionId: item.sessionId,
    payload: { availableAt: item.availableAt },
  };
}

/** Returns whether an ISO available-at timestamp is due at the supplied time. */
export function isWorkAvailableAtDue(availableAt: string, now: Date): boolean {
  return Date.parse(availableAt) <= now.getTime();
}

/** Returns whether a work status is terminal. */
export function isTerminalWorkStatus(status: WorkStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Creates a queued work item and its `work.created` event input. */
export function createQueuedWorkItem(
  input: SubmitWorkInput,
  options: CreateQueuedWorkItemOptions,
): CreateQueuedWorkItemResult {
  const now = iso(options.now);
  const item: WorkItem = {
    id: input.id ?? options.id,
    kind: input.kind,
    sessionId: input.sessionId,
    payload: input.payload,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    availableAt: iso(input.availableAt ?? options.now),
    attempts: 0,
  };
  return {
    outcome: "created",
    item,
    event: createdEvent(item),
  };
}

/** Checks whether a work item can be leased at the supplied time and kind filter. */
export function checkWorkLeaseEligibility(
  item: WorkItem | null,
  options: { kinds?: readonly WorkKind[]; now: Date },
): WorkLeaseEligibility {
  if (!item) return { eligible: false, reason: "missing" };
  if (item.status !== "queued") return { eligible: false, reason: "not_queued" };
  if (!isWorkAvailableAtDue(item.availableAt, options.now)) return { eligible: false, reason: "not_due" };
  if (!matchesKind(item.kind, options.kinds)) return { eligible: false, reason: "wrong_kind" };
  return { eligible: true };
}

/** Leases a due queued work item and returns its `work.leased` event input. */
export function leaseQueuedWork(item: WorkItem | null, options: LeaseQueuedWorkOptions): LeaseQueuedWorkResult {
  const eligibility = checkWorkLeaseEligibility(item, options);
  if (!eligibility.eligible) {
    return {
      outcome: "not_eligible",
      item,
      reason: eligibility.reason,
    };
  }
  if (!item || item.status !== "queued") {
    throw new Error("Eligible work item was not queued");
  }

  const leased: LeasedWorkItem = {
    ...item,
    status: "leased",
    updatedAt: iso(options.now),
    attempts: item.attempts + 1,
    lease: {
      id: options.leaseId,
      ownerId: options.ownerId,
      leasedAt: iso(options.now),
    },
  };
  return {
    outcome: "leased",
    item: leased,
    event: leasedEvent(leased),
  };
}

/** Asserts that a work item is leased with the supplied lease id. */
export function assertMatchingWorkLease(item: WorkItem | null, leaseId: string): asserts item is LeasedWorkItem {
  if (!item) throw new Error("Work item not found");
  if (item.status !== "leased" || !item.lease) throw new Error("Work item is not leased");
  if (item.lease.id !== leaseId) throw new Error("Work lease mismatch");
}

/** Completes a matching leased work item and returns its `work.completed` event input. */
export function completeLeasedWork(
  item: WorkItem | null,
  options: CompleteLeasedWorkOptions,
): CompleteLeasedWorkResult {
  assertMatchingWorkLease(item, options.leaseId);
  const completed: WorkItem = {
    ...withoutLease(item),
    status: "completed",
    updatedAt: iso(options.now),
  };
  return {
    outcome: "completed",
    item: completed,
    event: completedEvent(completed),
  };
}

/** Releases a matching leased work item back to queued state. */
export function releaseLeasedWork(
  item: WorkItem | null,
  options: ReleaseLeasedWorkOptions,
): ReleaseLeasedWorkResult {
  assertMatchingWorkLease(item, options.leaseId);
  const queued: WorkItem = {
    ...withoutLease(item),
    status: "queued",
    updatedAt: iso(options.now),
    availableAt: iso(options.availableAt ?? options.now),
  };
  return {
    outcome: "released",
    item: queued,
    event: releasedEvent(queued),
  };
}

/** Fails a matching leased work item and returns its `work.failed` event input. */
export function failLeasedWork(item: WorkItem | null, options: FailLeasedWorkOptions): FailLeasedWorkResult {
  assertMatchingWorkLease(item, options.leaseId);
  const failed: WorkItem = {
    ...withoutLease(item),
    status: "failed",
    updatedAt: iso(options.now),
    failure: options.reason,
  };
  return {
    outcome: "failed",
    item: failed,
    event: failedEvent(failed, options.reason),
  };
}

/** Cancels non-terminal work and returns its `work.cancelled` event input. */
export function cancelNonTerminalWork(
  item: WorkItem | null,
  options: CancelNonTerminalWorkOptions,
): CancelNonTerminalWorkResult {
  if (!item) throw new Error("Work item not found");
  if (isTerminalWorkStatus(item.status)) {
    return {
      outcome: "already_terminal",
      item,
    };
  }
  const cancelled: WorkItem = {
    ...withoutLease(item),
    status: "cancelled",
    updatedAt: iso(options.now),
    failure: options.reason,
  };
  return {
    outcome: "cancelled",
    item: cancelled,
    event: cancelledEvent(cancelled, options.reason),
  };
}

/** Recovers interrupted leased work by requeueing it or failing it after too many attempts. */
export function recoverInterruptedLeasedWork(
  item: WorkItem | null,
  options: RecoverInterruptedLeasedWorkOptions,
): RecoverInterruptedLeasedWorkResult {
  if (!item || item.status !== "leased" || !item.lease) {
    return {
      outcome: "not_eligible",
      item,
    };
  }
  if (item.attempts >= options.maxAttempts) {
    const failed: WorkItem = {
      ...withoutLease(item),
      status: "failed",
      updatedAt: iso(options.now),
      failure: INTERRUPTED_WORK_FAILURE,
    };
    return {
      outcome: "failed",
      item: failed,
      event: failedEvent(failed, INTERRUPTED_WORK_FAILURE),
    };
  }

  const queued: WorkItem = {
    ...withoutLease(item),
    status: "queued",
    updatedAt: iso(options.now),
    availableAt: iso(options.now),
  };
  return {
    outcome: "requeued",
    item: queued,
    event: releasedEvent(queued),
  };
}
