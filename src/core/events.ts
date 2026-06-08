/** Durable v4 event categories emitted by the agent harness. */
export type EventCategory =
  | "work.created"
  | "work.leased"
  | "turn.input"
  | "model.round.started"
  | "model.message"
  | "tool.requested"
  | "approval.requested"
  | "approval.decided"
  | "tool.completed"
  | "interaction.requested"
  | "interaction.completed"
  | "egress.queued"
  | "egress.sent"
  | "egress.dropped"
  | "session.compacted"
  | "work.completed"
  | "work.failed"
  | "work.cancelled";

/** Append input for a durable event before store-owned metadata is assigned. */
export interface AppendEventInput {
  /** Event category. */
  category: EventCategory;
  /** Work item associated with this event, when any. */
  workId?: string;
  /** Session associated with this event, when any. */
  sessionId?: string;
  /** Structured event payload. */
  payload: unknown;
  /** Optional event creation time, mostly for deterministic tests. */
  createdAt?: Date;
}

/** One append-only v4 event. */
export interface DurableEvent {
  /** Stable event identifier. */
  id: string;
  /** Monotonic sequence number within the event store. */
  sequence: number;
  /** Event category. */
  category: EventCategory;
  /** ISO timestamp when the event was appended. */
  createdAt: string;
  /** Work item associated with this event, when any. */
  workId?: string;
  /** Session associated with this event, when any. */
  sessionId?: string;
  /** Structured event payload. */
  payload: unknown;
}

/** Durable event-store port. */
export interface EventStore {
  /** Appends one event and returns the stored record. */
  append(input: AppendEventInput): Promise<DurableEvent>;
  /** Appends multiple events in order. */
  appendMany(inputs: readonly AppendEventInput[]): Promise<DurableEvent[]>;
  /** Lists all events in sequence order. */
  list(options?: EventListOptions): Promise<DurableEvent[]>;
  /** Lists events for a work item in sequence order. */
  listByWork(workId: string, options?: EventListOptions): Promise<DurableEvent[]>;
  /** Lists events for a session in sequence order. */
  listBySession(sessionId: string, options?: EventListOptions): Promise<DurableEvent[]>;
}

/** Event listing options. */
export interface EventListOptions {
  /** Minimum exclusive sequence. */
  afterSequence?: number;
  /** Maximum number of events to return. */
  limit?: number;
}

const EVENT_SEQUENCE_KEY: Deno.KvKey = ["core", "events", "sequence"];
const EVENT_BY_SEQUENCE_PREFIX: Deno.KvKey = ["core", "events", "by-sequence"];
const EVENT_BY_WORK_PREFIX: Deno.KvKey = ["core", "events", "by-work"];
const EVENT_BY_SESSION_PREFIX: Deno.KvKey = ["core", "events", "by-session"];

function eventBySequenceKey(sequence: number): Deno.KvKey {
  return [...EVENT_BY_SEQUENCE_PREFIX, sequence];
}

function eventByWorkKey(workId: string, sequence: number): Deno.KvKey {
  return [...EVENT_BY_WORK_PREFIX, workId, sequence];
}

function eventBySessionKey(sessionId: string, sequence: number): Deno.KvKey {
  return [...EVENT_BY_SESSION_PREFIX, sessionId, sequence];
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

/** Deno KV-backed append-only event store. */
export class KvEventStore implements EventStore {
  private readonly _kv: Deno.Kv;

  /** Creates a KV event store. */
  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  /** Appends one event with a monotonic sequence number. */
  async append(input: AppendEventInput): Promise<DurableEvent> {
    while (true) {
      const sequenceEntry = await this._kv.get<number>(EVENT_SEQUENCE_KEY);
      const sequence = (sequenceEntry.value ?? 0) + 1;
      const event: DurableEvent = {
        id: crypto.randomUUID(),
        sequence,
        category: input.category,
        createdAt: (input.createdAt ?? new Date()).toISOString(),
        payload: input.payload,
        ...(input.workId !== undefined ? { workId: input.workId } : {}),
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      };

      let atomic = this._kv.atomic()
        .check(sequenceEntry)
        .set(EVENT_SEQUENCE_KEY, sequence)
        .set(eventBySequenceKey(sequence), event);
      if (event.workId !== undefined) atomic = atomic.set(eventByWorkKey(event.workId, sequence), event);
      if (event.sessionId !== undefined) atomic = atomic.set(eventBySessionKey(event.sessionId, sequence), event);

      const result = await atomic.commit();
      if (result.ok) return event;
    }
  }

  /** Appends events in caller order. */
  async appendMany(inputs: readonly AppendEventInput[]): Promise<DurableEvent[]> {
    const events: DurableEvent[] = [];
    for (const input of inputs) {
      events.push(await this.append(input));
    }
    return events;
  }

  /** Lists all events in sequence order. */
  async list(options?: EventListOptions): Promise<DurableEvent[]> {
    return await this._list(EVENT_BY_SEQUENCE_PREFIX, options);
  }

  /** Lists events for one work item in sequence order. */
  async listByWork(workId: string, options?: EventListOptions): Promise<DurableEvent[]> {
    return await this._list([...EVENT_BY_WORK_PREFIX, workId], options);
  }

  /** Lists events for one session in sequence order. */
  async listBySession(sessionId: string, options?: EventListOptions): Promise<DurableEvent[]> {
    return await this._list([...EVENT_BY_SESSION_PREFIX, sessionId], options);
  }

  /** Lists events from a KV prefix. */
  private async _list(prefix: Deno.KvKey, options?: EventListOptions): Promise<DurableEvent[]> {
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

/** In-memory event store for adapter and runner tests. */
export class MemoryEventStore implements EventStore {
  private readonly _events: DurableEvent[] = [];

  /** Appends one event with an in-memory sequence number. */
  append(input: AppendEventInput): Promise<DurableEvent> {
    const event: DurableEvent = {
      id: crypto.randomUUID(),
      sequence: this._events.length + 1,
      category: input.category,
      createdAt: (input.createdAt ?? new Date()).toISOString(),
      payload: input.payload,
      ...(input.workId !== undefined ? { workId: input.workId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    };
    this._events.push(event);
    return Promise.resolve(event);
  }

  /** Appends events in caller order. */
  async appendMany(inputs: readonly AppendEventInput[]): Promise<DurableEvent[]> {
    const events: DurableEvent[] = [];
    for (const input of inputs) events.push(await this.append(input));
    return events;
  }

  /** Lists all events in sequence order. */
  list(options?: EventListOptions): Promise<DurableEvent[]> {
    return Promise.resolve(this._filter(this._events, options));
  }

  /** Lists events for one work item in sequence order. */
  listByWork(workId: string, options?: EventListOptions): Promise<DurableEvent[]> {
    return Promise.resolve(this._filter(this._events.filter((event) => event.workId === workId), options));
  }

  /** Lists events for one session in sequence order. */
  listBySession(sessionId: string, options?: EventListOptions): Promise<DurableEvent[]> {
    return Promise.resolve(this._filter(this._events.filter((event) => event.sessionId === sessionId), options));
  }

  /** Applies common list filters. */
  private _filter(events: DurableEvent[], options?: EventListOptions): DurableEvent[] {
    const filtered = events.filter((event) => shouldIncludeEvent(event, options));
    return filtered.slice(0, options?.limit ?? filtered.length);
  }
}
