import type {
  AppendEventInput,
  DurableEvent,
  EventListOptions,
  KvAtomicEventMutation,
  KvEventMutationStore,
} from "./events.ts";
import type {
  CancelWorkOptions,
  CompleteWorkOptions,
  FailWorkOptions,
  LeasedWorkItem,
  LeaseWorkOptions,
  ListWorkOptions,
  RecoverInterruptedWorkOptions,
  RecoverInterruptedWorkResult,
  ReleaseWorkOptions,
  SubmitWorkInput,
  WorkItem,
  WorkQueue,
} from "./work-queue.ts";
import {
  cancelNonTerminalWork,
  completeLeasedWork,
  createQueuedWorkItem,
  failLeasedWork,
  isWorkAvailableAtDue,
  leaseQueuedWork,
  recoverInterruptedLeasedWork,
  releaseLeasedWork,
} from "./work-state.ts";

const EVENT_SEQUENCE_KEY: Deno.KvKey = ["core", "events", "sequence"];
const EVENT_BY_SEQUENCE_PREFIX: Deno.KvKey = ["core", "events", "by-sequence"];
const EVENT_BY_WORK_PREFIX: Deno.KvKey = ["core", "events", "by-work"];
const EVENT_BY_SESSION_PREFIX: Deno.KvKey = ["core", "events", "by-session"];

const WORK_ITEM_PREFIX: Deno.KvKey = ["core", "work", "item"];
const WORK_QUEUED_PREFIX: Deno.KvKey = ["core", "work", "queued"];
const WORK_LEASED_PREFIX: Deno.KvKey = ["core", "work", "leased"];

function eventBySequenceKey(sequence: number): Deno.KvKey {
  return [...EVENT_BY_SEQUENCE_PREFIX, sequence];
}

function eventByWorkKey(workId: string, sequence: number): Deno.KvKey {
  return [...EVENT_BY_WORK_PREFIX, workId, sequence];
}

function eventBySessionKey(sessionId: string, sequence: number): Deno.KvKey {
  return [...EVENT_BY_SESSION_PREFIX, sessionId, sequence];
}

function workItemKey(id: string): Deno.KvKey {
  return [...WORK_ITEM_PREFIX, id];
}

function queuedKey(availableAt: string, id: string): Deno.KvKey {
  return [...WORK_QUEUED_PREFIX, availableAt, id];
}

function leasedKey(id: string): Deno.KvKey {
  return [...WORK_LEASED_PREFIX, id];
}

function listSelector(prefix: Deno.KvKey, options?: EventListOptions): Deno.KvListSelector {
  if (options?.afterSequence === undefined) return { prefix };
  return {
    prefix,
    start: [...prefix, options.afterSequence + 1],
  };
}

function shouldIncludeEvent(event: DurableEvent, options?: EventListOptions): boolean {
  return options?.afterSequence === undefined || event.sequence > options.afterSequence;
}

function durableEvent(input: AppendEventInput, sequence: number): DurableEvent {
  return {
    id: crypto.randomUUID(),
    sequence,
    category: input.category,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    payload: input.payload,
    ...(input.workId !== undefined ? { workId: input.workId } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
  };
}

function setEventIndexes(atomic: Deno.AtomicOperation, event: DurableEvent): Deno.AtomicOperation {
  let next = atomic.set(eventBySequenceKey(event.sequence), event);
  if (event.workId !== undefined) next = next.set(eventByWorkKey(event.workId, event.sequence), event);
  if (event.sessionId !== undefined) next = next.set(eventBySessionKey(event.sessionId, event.sequence), event);
  return next;
}

function matchesWorkListOptions(item: WorkItem, options?: ListWorkOptions): boolean {
  if (options?.kind !== undefined && item.kind !== options.kind) return false;
  if (options?.sessionId !== undefined && item.sessionId !== options.sessionId) return false;
  if (options?.statuses !== undefined && !options.statuses.includes(item.status)) return false;
  return true;
}

/** Durable kernel backed by one Deno KV store for both events and work lifecycle state. */
export class KvKernelStore implements KvEventMutationStore, WorkQueue {
  private readonly _kv: Deno.Kv;

  /** Creates a KV-backed kernel store. */
  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  /** Appends one event with a monotonic sequence number. */
  async append(input: AppendEventInput): Promise<DurableEvent> {
    return (await this.appendMany([input]))[0]!;
  }

  /** Appends events in caller order. */
  async appendMany(inputs: readonly AppendEventInput[]): Promise<DurableEvent[]> {
    return await this.commitKvMutationWithEvents((atomic) => atomic, inputs);
  }

  /** Commits a KV mutation and durable event appends in the same atomic operation. */
  async commitKvMutationWithEvents(
    mutation: KvAtomicEventMutation,
    events: readonly AppendEventInput[],
  ): Promise<DurableEvent[]> {
    while (true) {
      const committed = await this._tryCommitKvMutationWithEvents(mutation, events);
      if (committed) return committed;
    }
  }

  /** Lists all events in sequence order. */
  async list(options?: EventListOptions): Promise<DurableEvent[]> {
    return await this._listEvents(EVENT_BY_SEQUENCE_PREFIX, options);
  }

  /** Lists events for one work item in sequence order. */
  async listByWork(workId: string, options?: EventListOptions): Promise<DurableEvent[]> {
    return await this._listEvents([...EVENT_BY_WORK_PREFIX, workId], options);
  }

  /** Lists events for one session in sequence order. */
  async listBySession(sessionId: string, options?: EventListOptions): Promise<DurableEvent[]> {
    return await this._listEvents([...EVENT_BY_SESSION_PREFIX, sessionId], options);
  }

  /** Submits a queued work item and atomically emits `work.created`. */
  async submit(input: SubmitWorkInput): Promise<WorkItem> {
    while (true) {
      const transition = createQueuedWorkItem(input, {
        id: input.id ?? crypto.randomUUID(),
        now: new Date(),
      });
      const work = transition.item;
      const itemEntry = await this._kv.get<WorkItem>(workItemKey(work.id));
      if (itemEntry.value) throw new Error(`Work item already exists: ${work.id}`);
      const committed = await this._tryCommitKvMutationWithEvents(
        (atomic) =>
          atomic
            .check(itemEntry)
            .set(workItemKey(work.id), work)
            .set(queuedKey(work.availableAt, work.id), work.id),
        [transition.event],
      );
      if (committed) return work;
    }
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
      const committed = await this._tryCommitKvMutationWithEvents(
        (atomic) =>
          atomic
            .check(itemEntry)
            .delete(queuedKey(leased.availableAt, id))
            .set(workItemKey(id), leased)
            .set(leasedKey(id), id),
        [transition.event],
      );
      if (committed) return leased;
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
      const committed = await this._tryCommitKvMutationWithEvents(
        (atomic) =>
          atomic
            .check(queuedEntry)
            .check(itemEntry)
            .delete(queuedEntry.key)
            .set(workItemKey(id), leased)
            .set(leasedKey(id), id),
        [transition.event],
      );
      if (committed) return leased;
    }
    return null;
  }

  /** Marks leased work as completed. */
  async complete(id: string, options: CompleteWorkOptions): Promise<void> {
    while (true) {
      const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
      const transition = completeLeasedWork(itemEntry.value, {
        leaseId: options.leaseId,
        now: options.now ?? new Date(),
      });
      const committed = await this._tryCommitKvMutationWithEvents(
        (atomic) =>
          atomic
            .check(itemEntry)
            .delete(leasedKey(id))
            .set(workItemKey(id), transition.item),
        [transition.event],
      );
      if (committed) return;
    }
  }

  /** Returns leased work to queued state. */
  async release(id: string, options: ReleaseWorkOptions): Promise<void> {
    while (true) {
      const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
      const transition = releaseLeasedWork(itemEntry.value, {
        leaseId: options.leaseId,
        now: options.now ?? new Date(),
        availableAt: options.availableAt,
      });
      const queued = transition.item;
      const committed = await this._tryCommitKvMutationWithEvents(
        (atomic) =>
          atomic
            .check(itemEntry)
            .delete(leasedKey(id))
            .set(workItemKey(id), queued)
            .set(queuedKey(queued.availableAt, id), id),
        [transition.event],
      );
      if (committed) return;
    }
  }

  /** Marks leased work as failed. */
  async fail(id: string, options: FailWorkOptions): Promise<void> {
    while (true) {
      const itemEntry = await this._kv.get<WorkItem>(workItemKey(id));
      const transition = failLeasedWork(itemEntry.value, {
        leaseId: options.leaseId,
        now: options.now ?? new Date(),
        reason: options.reason,
      });
      const committed = await this._tryCommitKvMutationWithEvents(
        (atomic) =>
          atomic
            .check(itemEntry)
            .delete(leasedKey(id))
            .set(workItemKey(id), transition.item),
        [transition.event],
      );
      if (committed) return;
    }
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

      const committed = await this._tryCommitKvMutationWithEvents(
        (atomic) => {
          let next = atomic.check(itemEntry).set(workItemKey(id), transition.item);
          if (item.status === "queued") next = next.delete(queuedKey(item.availableAt, id));
          if (item.status === "leased" && item.lease) next = next.delete(leasedKey(id));
          return next;
        },
        [transition.event],
      );
      if (committed) return;
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
      const committed = await this._tryCommitKvMutationWithEvents(
        (atomic) => {
          let next = atomic
            .check(leaseEntry)
            .check(itemEntry)
            .delete(leaseEntry.key)
            .set(workItemKey(id), transition.item);
          if (transition.outcome === "requeued") {
            next = next.set(queuedKey(transition.item.availableAt, id), id);
          }
          return next;
        },
        [transition.event],
      );
      if (!committed) continue;
      if (transition.outcome === "requeued") requeued.push(id);
      else failed.push(id);
    }
    return { requeued, failed };
  }

  /** Lists durable work items. */
  async listWork(options?: ListWorkOptions): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    for await (const entry of this._kv.list<WorkItem>({ prefix: WORK_ITEM_PREFIX })) {
      if (matchesWorkListOptions(entry.value, options)) items.push(entry.value);
    }
    return items.toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
  }

  /** Commits one KV mutation together with appended events, retrying on sequence conflicts. */
  private async _tryCommitKvMutationWithEvents(
    mutation: KvAtomicEventMutation,
    inputs: readonly AppendEventInput[],
  ): Promise<DurableEvent[] | null> {
    const sequenceEntry = await this._kv.get<number>(EVENT_SEQUENCE_KEY);
    const baseSequence = sequenceEntry.value ?? 0;
    const events = inputs.map((input, index) => durableEvent(input, baseSequence + index + 1));
    let atomic = this._kv.atomic().check(sequenceEntry).set(EVENT_SEQUENCE_KEY, baseSequence + events.length);
    for (const event of events) atomic = setEventIndexes(atomic, event);
    const result = await mutation(atomic).commit();
    return result.ok ? events : null;
  }

  /** Lists durable events under one KV prefix in sequence order. */
  private async _listEvents(prefix: Deno.KvKey, options?: EventListOptions): Promise<DurableEvent[]> {
    const events: DurableEvent[] = [];
    const limit = options?.limit ?? Number.POSITIVE_INFINITY;
    for await (const entry of this._kv.list<DurableEvent>(listSelector(prefix, options))) {
      if (!shouldIncludeEvent(entry.value, options)) continue;
      events.push(entry.value);
      if (events.length >= limit) break;
    }
    return events;
  }
}
