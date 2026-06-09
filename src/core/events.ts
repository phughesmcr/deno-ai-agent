/** Durable v4 event categories emitted by the agent harness. */
export type EventCategory =
  | "work.created"
  | "work.leased"
  | "work.released"
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

/** KV mutation that can be committed with durable events in the same atomic operation. */
export type KvAtomicEventMutation = (atomic: Deno.AtomicOperation) => Deno.AtomicOperation;

/** Event store extension for committing non-event KV mutations with event appends atomically. */
export interface KvEventMutationStore extends EventStore {
  /** Commits a KV mutation and the supplied events through one atomic Deno KV operation. */
  commitKvMutationWithEvents(
    mutation: KvAtomicEventMutation,
    events: readonly AppendEventInput[],
  ): Promise<DurableEvent[]>;
}

/** Event listing options. */
export interface EventListOptions {
  /** Minimum exclusive sequence. */
  afterSequence?: number;
  /** Maximum number of events to return. */
  limit?: number;
}

/** Returns true when an event store can commit KV mutations with events atomically. */
export function isKvEventMutationStore(events: EventStore): events is KvEventMutationStore {
  return "commitKvMutationWithEvents" in events &&
    typeof (events as { commitKvMutationWithEvents?: unknown }).commitKvMutationWithEvents === "function";
}
