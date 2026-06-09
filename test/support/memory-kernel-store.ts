import type { AppendEventInput, DurableEvent, EventListOptions, EventStore } from "../../src/core/events.ts";
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
} from "../../src/core/work-queue.ts";
import {
  cancelNonTerminalWork,
  checkWorkLeaseEligibility,
  completeLeasedWork,
  createQueuedWorkItem,
  failLeasedWork,
  leaseQueuedWork,
  recoverInterruptedLeasedWork,
  releaseLeasedWork,
} from "../../src/core/work-state.ts";

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

function cloneWorkItem<T extends WorkItem>(item: T): T {
  return structuredClone(item);
}

function matchesWorkListOptions(item: WorkItem, options?: ListWorkOptions): boolean {
  if (options?.kind !== undefined && item.kind !== options.kind) return false;
  if (options?.sessionId !== undefined && item.sessionId !== options.sessionId) return false;
  if (options?.statuses !== undefined && !options.statuses.includes(item.status)) return false;
  return true;
}

/** In-memory kernel store for adapter and runner tests. */
export class MemoryKernelStore implements WorkQueue, EventStore {
  private readonly _events: DurableEvent[] = [];
  private readonly _items = new Map<string, WorkItem>();

  /** Appends one event with an in-memory sequence number. */
  append(input: AppendEventInput): Promise<DurableEvent> {
    const event = this._appendEvent(input);
    return Promise.resolve(event);
  }

  /** Appends events in caller order. */
  appendMany(inputs: readonly AppendEventInput[]): Promise<DurableEvent[]> {
    return Promise.resolve(inputs.map((input) => this._appendEvent(input)));
  }

  /** Lists all events in sequence order. */
  list(options?: EventListOptions): Promise<DurableEvent[]> {
    return Promise.resolve(this._filterEvents(this._events, options));
  }

  /** Lists events for one work item in sequence order. */
  listByWork(workId: string, options?: EventListOptions): Promise<DurableEvent[]> {
    return Promise.resolve(this._filterEvents(this._events.filter((event) => event.workId === workId), options));
  }

  /** Lists events for one session in sequence order. */
  listBySession(sessionId: string, options?: EventListOptions): Promise<DurableEvent[]> {
    return Promise.resolve(this._filterEvents(this._events.filter((event) => event.sessionId === sessionId), options));
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
    await this.append(transition.event);
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
    await this.append(transition.event);
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
    await this.append(transition.event);
    return cloneWorkItem(leased);
  }

  /** Marks leased work as completed. */
  async complete(id: string, options: CompleteWorkOptions): Promise<void> {
    const transition = completeLeasedWork(this._items.get(id) ?? null, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
    });
    this._items.set(id, cloneWorkItem(transition.item));
    await this.append(transition.event);
  }

  /** Returns leased work to queued state. */
  async release(id: string, options: ReleaseWorkOptions): Promise<void> {
    const transition = releaseLeasedWork(this._items.get(id) ?? null, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
      availableAt: options.availableAt,
    });
    this._items.set(id, cloneWorkItem(transition.item));
    await this.append(transition.event);
  }

  /** Marks leased work as failed. */
  async fail(id: string, options: FailWorkOptions): Promise<void> {
    const transition = failLeasedWork(this._items.get(id) ?? null, {
      leaseId: options.leaseId,
      now: options.now ?? new Date(),
      reason: options.reason,
    });
    this._items.set(id, cloneWorkItem(transition.item));
    await this.append(transition.event);
  }

  /** Cancels queued or leased work. */
  async cancel(id: string, options: CancelWorkOptions): Promise<void> {
    const transition = cancelNonTerminalWork(this._items.get(id) ?? null, {
      reason: options.reason,
      now: options.now ?? new Date(),
    });
    if (transition.outcome === "already_terminal") return;
    this._items.set(id, cloneWorkItem(transition.item));
    await this.append(transition.event);
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
      await this.append(transition.event);
      if (transition.outcome === "failed") failed.push(item.id);
      else requeued.push(item.id);
    }
    return { requeued, failed };
  }

  /** Lists durable work items. */
  listWork(options?: ListWorkOptions): Promise<WorkItem[]> {
    const items = [...this._items.values()]
      .filter((item) => matchesWorkListOptions(item, options))
      .map((item) => cloneWorkItem(item))
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return Promise.resolve(items);
  }

  private _appendEvent(input: AppendEventInput): DurableEvent {
    const event = durableEvent(input, this._events.length + 1);
    this._events.push(event);
    return event;
  }

  private _filterEvents(events: DurableEvent[], options?: EventListOptions): DurableEvent[] {
    const filtered = events.filter((event) => shouldIncludeEvent(event, options));
    return filtered.slice(0, options?.limit ?? filtered.length);
  }
}
