import type { EventStore } from "./events.ts";
import {
  cancelNonTerminalWork,
  checkWorkLeaseEligibility,
  completeLeasedWork,
  createQueuedWorkItem,
  failLeasedWork,
  isWorkAvailableAtDue,
  leaseQueuedWork,
  recoverInterruptedLeasedWork,
  releaseLeasedWork,
} from "./work_state.ts";

/** Work kinds accepted by the durable harness. */
export type WorkKind = "user_turn" | "cron_run" | "subagent_run" | "maintenance";

/** Durable work lifecycle states. */
export type WorkStatus = "queued" | "leased" | "completed" | "failed" | "cancelled";

/** Lease metadata for in-progress work. */
export interface WorkLease {
  /** Stable lease id. */
  id: string;
  /** Host/process that owns the lease. */
  ownerId: string;
  /** ISO timestamp when the lease was acquired. */
  leasedAt: string;
}

/** One durable work item. */
export interface WorkItem {
  /** Stable work id. */
  id: string;
  /** Work kind. */
  kind: WorkKind;
  /** Session this work belongs to. */
  sessionId: string;
  /** Adapter-owned payload. */
  payload: unknown;
  /** Lifecycle status. */
  status: WorkStatus;
  /** ISO timestamp when work was created. */
  createdAt: string;
  /** ISO timestamp when work was last updated. */
  updatedAt: string;
  /** ISO timestamp when queued work may be leased. */
  availableAt: string;
  /** Number of lease attempts. */
  attempts: number;
  /** Current lease for leased work. */
  lease?: WorkLease;
  /** Terminal failure reason. */
  failure?: string;
}

/** Leased work item with lease metadata present. */
export type LeasedWorkItem = WorkItem & {
  status: "leased";
  lease: WorkLease;
};

/** Work submission input. */
export interface SubmitWorkInput {
  /** Optional caller-owned id. */
  id?: string;
  /** Work kind. */
  kind: WorkKind;
  /** Session this work belongs to. */
  sessionId: string;
  /** Adapter-owned payload. */
  payload: unknown;
  /** Earliest lease time. */
  availableAt?: Date;
}

/** Lease request options. */
export interface LeaseWorkOptions {
  /** Host/process requesting the lease. */
  ownerId: string;
  /** Optional work kind filter. */
  kinds?: readonly WorkKind[];
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Completion options. */
export interface CompleteWorkOptions {
  /** Current lease id. */
  leaseId: string;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Release options for returning leased work to the queue. */
export interface ReleaseWorkOptions extends CompleteWorkOptions {
  /** Earliest future lease time. Defaults to now. */
  availableAt?: Date;
}

/** Failure options. */
export interface FailWorkOptions extends CompleteWorkOptions {
  /** Failure reason. */
  reason: string;
}

/** Cancellation options. */
export interface CancelWorkOptions {
  /** Cancellation reason. */
  reason: string;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Interrupted work recovery options. */
export interface RecoverInterruptedWorkOptions {
  /** Current time. */
  now?: Date;
  /** Maximum lease attempts before failing a work item. */
  maxAttempts: number;
}

/** Interrupted work recovery result. */
export interface RecoverInterruptedWorkResult {
  /** Work ids moved back to queued. */
  requeued: string[];
  /** Work ids failed because attempts were exhausted. */
  failed: string[];
}

/** Durable queue port. */
export interface WorkQueue {
  /** Submits work to the durable queue. */
  submit(input: SubmitWorkInput): Promise<WorkItem>;
  /** Returns a work item by id. */
  get(id: string): Promise<WorkItem | null>;
  /** Leases a specific due queued work item by id. */
  lease(id: string, options: LeaseWorkOptions): Promise<LeasedWorkItem | null>;
  /** Leases the next available work item. */
  leaseNext(options: LeaseWorkOptions): Promise<LeasedWorkItem | null>;
  /** Marks leased work completed. */
  complete(id: string, options: CompleteWorkOptions): Promise<void>;
  /** Returns leased work to queued state. */
  release(id: string, options: ReleaseWorkOptions): Promise<void>;
  /** Marks leased work failed. */
  fail(id: string, options: FailWorkOptions): Promise<void>;
  /** Cancels queued or leased work. */
  cancel(id: string, options: CancelWorkOptions): Promise<void>;
  /** Recovers interrupted leased work after restart or host failure. */
  recoverInterruptedWork(options: RecoverInterruptedWorkOptions): Promise<RecoverInterruptedWorkResult>;
}

const WORK_ITEM_PREFIX: Deno.KvKey = ["core", "work", "item"];
const WORK_QUEUED_PREFIX: Deno.KvKey = ["core", "work", "queued"];
const WORK_LEASED_PREFIX: Deno.KvKey = ["core", "work", "leased"];

function workItemKey(id: string): Deno.KvKey {
  return [...WORK_ITEM_PREFIX, id];
}

function queuedKey(availableAt: string, id: string): Deno.KvKey {
  return [...WORK_QUEUED_PREFIX, availableAt, id];
}

function leasedKey(id: string): Deno.KvKey {
  return [...WORK_LEASED_PREFIX, id];
}

/** Deno KV-backed durable work queue. */
export class KvWorkQueue implements WorkQueue {
  private readonly _kv: Deno.Kv;
  private readonly _events: EventStore;

  /** Creates a KV work queue. */
  constructor(options: { kv: Deno.Kv; events: EventStore }) {
    this._kv = options.kv;
    this._events = options.events;
  }

  /** Submits a queued work item and emits `work.created`. */
  async submit(input: SubmitWorkInput): Promise<WorkItem> {
    const transition = createQueuedWorkItem(input, {
      id: input.id ?? crypto.randomUUID(),
      now: new Date(),
    });
    const work = transition.item;
    const itemEntry = await this._kv.get<WorkItem>(workItemKey(work.id));
    if (itemEntry.value) throw new Error(`Work item already exists: ${work.id}`);

    const result = await this._kv.atomic()
      .check(itemEntry)
      .set(workItemKey(work.id), work)
      .set(queuedKey(work.availableAt, work.id), work.id)
      .commit();
    if (!result.ok) throw new Error(`Work item already exists: ${work.id}`);

    await this._events.append(transition.event);
    return work;
  }

  /** Gets a work item by id. */
  async get(id: string): Promise<WorkItem | null> {
    return (await this._kv.get<WorkItem>(workItemKey(id))).value ?? null;
  }

  /** Leases a specific due queued work item by id. */
  async lease(id: string, options: LeaseWorkOptions): Promise<LeasedWorkItem | null> {
    const now = options.now ?? new Date();
    while (true) {
      const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
      const transition = leaseQueuedWork(itemEntry.value, {
        ownerId: options.ownerId,
        leaseId: crypto.randomUUID(),
        kinds: options.kinds,
        now,
      });
      if (transition.outcome === "not_eligible") return null;
      const leased = transition.item;
      const result = await this._kv.atomic()
        .check(itemEntry)
        .delete(queuedKey(leased.availableAt, id))
        .set(workItemKey(id), leased)
        .set(leasedKey(id), id)
        .commit();
      if (!result.ok) continue;

      await this._events.append(transition.event);
      return leased;
    }
  }

  /** Leases the next due queued work item. */
  async leaseNext(options: LeaseWorkOptions): Promise<LeasedWorkItem | null> {
    const now = options.now ?? new Date();
    for await (const queuedEntry of this._kv.list<string>({ prefix: WORK_QUEUED_PREFIX })) {
      const availableAt = String(queuedEntry.key[3]);
      if (!isWorkAvailableAtDue(availableAt, now)) break;
      const id = queuedEntry.value;
      const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
      const transition = leaseQueuedWork(itemEntry.value, {
        ownerId: options.ownerId,
        leaseId: crypto.randomUUID(),
        kinds: options.kinds,
        now,
      });
      if (transition.outcome === "not_eligible") {
        const item = itemEntry.value;
        if (!item || item.status !== "queued" || item.availableAt !== availableAt) {
          await this._kv.delete(queuedEntry.key);
        }
        continue;
      }
      const leased = transition.item;
      const result = await this._kv.atomic()
        .check(queuedEntry)
        .check(itemEntry)
        .delete(queuedEntry.key)
        .set(workItemKey(id), leased)
        .set(leasedKey(id), id)
        .commit();
      if (!result.ok) continue;

      await this._events.append(transition.event);
      return leased;
    }
    return null;
  }

  /** Marks leased work as completed. */
  async complete(id: string, options: CompleteWorkOptions): Promise<void> {
    const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
    const transition = completeLeasedWork(itemEntry.value, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
    });
    const result = await this._kv.atomic()
      .check(itemEntry)
      .delete(leasedKey(id))
      .set(workItemKey(id), transition.item)
      .commit();
    if (!result.ok) throw new Error("Work item changed before completion");
    await this._events.append(transition.event);
  }

  /** Returns leased work to queued state. */
  async release(id: string, options: ReleaseWorkOptions): Promise<void> {
    const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
    const transition = releaseLeasedWork(itemEntry.value, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
      availableAt: options.availableAt,
    });
    const queued = transition.item;
    const result = await this._kv.atomic()
      .check(itemEntry)
      .delete(leasedKey(id))
      .set(workItemKey(id), queued)
      .set(queuedKey(queued.availableAt, id), id)
      .commit();
    if (!result.ok) throw new Error("Work item changed before release");
  }

  /** Marks leased work as failed. */
  async fail(id: string, options: FailWorkOptions): Promise<void> {
    const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
    const transition = failLeasedWork(itemEntry.value, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
      reason: options.reason,
    });
    const result = await this._kv.atomic()
      .check(itemEntry)
      .delete(leasedKey(id))
      .set(workItemKey(id), transition.item)
      .commit();
    if (!result.ok) throw new Error("Work item changed before failure");
    await this._events.append(transition.event);
  }

  /** Cancels queued or leased work. */
  async cancel(id: string, options: CancelWorkOptions): Promise<void> {
    const now = options.now ?? new Date();
    while (true) {
      const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
      const item = itemEntry.value;
      if (!item) throw new Error("Work item not found");
      const transition = cancelNonTerminalWork(item, {
        reason: options.reason,
        now,
      });
      if (transition.outcome === "already_terminal") return;

      let atomic = this._kv.atomic().check(itemEntry).set(workItemKey(id), transition.item);
      if (item.status === "queued") atomic = atomic.delete(queuedKey(item.availableAt, id));
      if (item.status === "leased" && item.lease) atomic = atomic.delete(leasedKey(id));
      const result = await atomic.commit();
      if (!result.ok) continue;

      await this._events.append(transition.event);
      return;
    }
  }

  /** Requeues or fails interrupted leased work from a previous host run. */
  async recoverInterruptedWork(options: RecoverInterruptedWorkOptions): Promise<RecoverInterruptedWorkResult> {
    const now = options.now ?? new Date();
    const requeued: string[] = [];
    const failed: string[] = [];
    for await (const leaseEntry of this._kv.list<string>({ prefix: WORK_LEASED_PREFIX })) {
      const id = leaseEntry.value;
      const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
      const transition = recoverInterruptedLeasedWork(itemEntry.value, {
        now,
        maxAttempts: options.maxAttempts,
      });
      if (transition.outcome === "not_eligible") {
        await this._kv.delete(leaseEntry.key);
        continue;
      }
      let atomic = this._kv.atomic()
        .check(leaseEntry)
        .check(itemEntry)
        .delete(leaseEntry.key)
        .set(workItemKey(id), transition.item);
      if (transition.outcome === "requeued") {
        atomic = atomic.set(queuedKey(transition.item.availableAt, id), id);
      }
      const result = await atomic.commit();
      if (!result.ok) continue;
      if (transition.outcome === "requeued") {
        requeued.push(id);
      } else {
        failed.push(id);
        await this._events.append(transition.event);
      }
    }
    return { requeued, failed };
  }
}

function cloneWorkItem<T extends WorkItem>(item: T): T {
  return structuredClone(item);
}

/** In-memory work queue for adapter tests. */
export class MemoryWorkQueue implements WorkQueue {
  private readonly _items = new Map<string, WorkItem>();
  private readonly _events: EventStore;

  /** Creates an in-memory work queue. */
  constructor(events: EventStore) {
    this._events = events;
  }

  /** Submits a queued work item and emits `work.created`. */
  async submit(input: SubmitWorkInput): Promise<WorkItem> {
    const transition = createQueuedWorkItem(input, {
      id: input.id ?? crypto.randomUUID(),
      now: new Date(),
    });
    const work = transition.item;
    if (this._items.has(work.id)) throw new Error(`Work item already exists: ${work.id}`);
    this._items.set(work.id, cloneWorkItem(work));
    await this._events.append(transition.event);
    return cloneWorkItem(work);
  }

  /** Gets a work item by id. */
  get(id: string): Promise<WorkItem | null> {
    const item = this._items.get(id);
    return Promise.resolve(item ? cloneWorkItem(item) : null);
  }

  /** Leases a specific due queued work item by id. */
  async lease(id: string, options: LeaseWorkOptions): Promise<LeasedWorkItem | null> {
    const transition = leaseQueuedWork(this._items.get(id) ?? null, {
      ownerId: options.ownerId,
      leaseId: crypto.randomUUID(),
      kinds: options.kinds,
      now: options.now ?? new Date(),
    });
    if (transition.outcome === "not_eligible") return null;
    const leased = transition.item;
    this._items.set(id, cloneWorkItem(leased));
    await this._events.append(transition.event);
    return cloneWorkItem(leased);
  }

  /** Leases the next due queued work item. */
  async leaseNext(options: LeaseWorkOptions): Promise<LeasedWorkItem | null> {
    const now = options.now ?? new Date();
    const queued = [...this._items.values()]
      .filter((item) => checkWorkLeaseEligibility(item, { kinds: options.kinds, now }).eligible)
      .sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.id.localeCompare(right.id));
    const item = queued[0];
    if (!item) return null;
    const transition = leaseQueuedWork(item, {
      ownerId: options.ownerId,
      leaseId: crypto.randomUUID(),
      kinds: options.kinds,
      now,
    });
    if (transition.outcome === "not_eligible") return null;
    const leased = transition.item;
    this._items.set(item.id, cloneWorkItem(leased));
    await this._events.append(transition.event);
    return cloneWorkItem(leased);
  }

  /** Marks leased work as completed. */
  async complete(id: string, options: CompleteWorkOptions): Promise<void> {
    const transition = completeLeasedWork(this._items.get(id) ?? null, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
    });
    this._items.set(id, cloneWorkItem(transition.item));
    await this._events.append(transition.event);
  }

  /** Returns leased work to queued state. */
  release(id: string, options: ReleaseWorkOptions): Promise<void> {
    const transition = releaseLeasedWork(this._items.get(id) ?? null, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
      availableAt: options.availableAt,
    });
    this._items.set(id, cloneWorkItem(transition.item));
    return Promise.resolve();
  }

  /** Marks leased work as failed. */
  async fail(id: string, options: FailWorkOptions): Promise<void> {
    const transition = failLeasedWork(this._items.get(id) ?? null, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
      reason: options.reason,
    });
    this._items.set(id, cloneWorkItem(transition.item));
    await this._events.append(transition.event);
  }

  /** Cancels queued or leased work. */
  async cancel(id: string, options: CancelWorkOptions): Promise<void> {
    const transition = cancelNonTerminalWork(this._items.get(id) ?? null, {
      reason: options.reason,
      now: options.now ?? new Date(),
    });
    if (transition.outcome === "already_terminal") return;
    this._items.set(id, cloneWorkItem(transition.item));
    await this._events.append(transition.event);
  }

  /** Requeues or fails interrupted leased work from a previous host run. */
  async recoverInterruptedWork(options: RecoverInterruptedWorkOptions): Promise<RecoverInterruptedWorkResult> {
    const now = options.now ?? new Date();
    const requeued: string[] = [];
    const failed: string[] = [];
    const leased = [...this._items.values()]
      .filter((item) =>
        recoverInterruptedLeasedWork(item, {
          now,
          maxAttempts: options.maxAttempts,
        }).outcome !== "not_eligible"
      )
      .sort((left, right) => (left.lease?.leasedAt ?? "").localeCompare(right.lease?.leasedAt ?? ""));
    for (const item of leased) {
      const transition = recoverInterruptedLeasedWork(item, {
        now,
        maxAttempts: options.maxAttempts,
      });
      if (transition.outcome === "not_eligible") continue;
      this._items.set(item.id, cloneWorkItem(transition.item));
      if (transition.outcome === "failed") {
        failed.push(item.id);
        await this._events.append(transition.event);
      } else {
        requeued.push(item.id);
      }
    }
    return { requeued, failed };
  }
}
