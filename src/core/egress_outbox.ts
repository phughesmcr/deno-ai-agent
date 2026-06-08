import type { DurableEvent, EventStore } from "./events.ts";

/** Payload persisted for queued adapter egress. */
export interface QueuedEgressPayload<TTarget = unknown> {
  /** Stable id used to match queued and sent events. */
  egressId: string;
  /** Adapter-specific destination. */
  target: TTarget;
  /** Assistant reply chunks to render. */
  replies: string[];
  /** Fallback text when no assistant reply chunks exist. */
  fallbackText?: string;
  /** ISO timestamp when egress was queued. */
  queuedAt: string;
}

/** Payload persisted when adapter egress has been sent. */
export interface SentEgressPayload<TTarget = unknown> extends QueuedEgressPayload<TTarget> {
  /** ISO timestamp when egress was sent. */
  sentAt: string;
}

/** Payload persisted when queued egress is permanently undeliverable. */
export interface DroppedEgressPayload<TTarget = unknown> extends QueuedEgressPayload<TTarget> {
  /** ISO timestamp when egress was dropped. */
  droppedAt: string;
  /** Drop reason. */
  reason: string;
}

/** Input for queueing egress before the external side effect. */
export interface QueueEgressInput<TTarget = unknown> {
  /** Work item associated with this egress. */
  workId: string;
  /** Session associated with this egress. */
  sessionId: string;
  /** Adapter-specific destination. */
  target: TTarget;
  /** Assistant reply chunks to render. */
  replies: readonly string[];
  /** Fallback text when no assistant reply chunks exist. */
  fallbackText?: string;
  /** Stable id override for deterministic tests. */
  egressId?: string;
  /** Deterministic clock for tests. */
  now?: Date;
}

/** Input for marking queued egress sent after the external side effect. */
export interface MarkEgressSentInput<TTarget = unknown> {
  /** Work item associated with this egress. */
  workId: string;
  /** Session associated with this egress. */
  sessionId: string;
  /** Queued payload to mark sent. */
  payload: QueuedEgressPayload<TTarget>;
  /** Deterministic clock for tests. */
  now?: Date;
}

/** Input for marking queued egress permanently undeliverable. */
export interface MarkEgressDroppedInput<TTarget = unknown> extends MarkEgressSentInput<TTarget> {
  /** Drop reason. */
  reason: string;
}

/** Queued egress that has no matching sent event. */
export interface PendingEgress<TTarget = unknown> {
  /** Queue event. */
  event: DurableEvent;
  /** Queue payload. */
  payload: QueuedEgressPayload<TTarget>;
}

/** Filters for pending egress replay. */
export interface PendingEgressOptions {
  /** Restrict to one work item. */
  workId?: string;
  /** Restrict to one session. */
  sessionId?: string;
}

function objectPayload(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  return payload as Record<string, unknown>;
}

function egressId(payload: unknown): string | undefined {
  const record = objectPayload(payload);
  return typeof record?.["egressId"] === "string" ? record["egressId"] : undefined;
}

function egressKey(event: DurableEvent, id: string): string {
  return JSON.stringify([event.workId ?? null, event.sessionId ?? null, id]);
}

function queuedPayload<TTarget>(payload: unknown): QueuedEgressPayload<TTarget> | undefined {
  const record = objectPayload(payload);
  if (!record) return undefined;
  if (typeof record["egressId"] !== "string") return undefined;
  if (!Array.isArray(record["replies"]) || !record["replies"].every((reply) => typeof reply === "string")) {
    return undefined;
  }
  if (typeof record["queuedAt"] !== "string") return undefined;
  const fallbackText = record["fallbackText"];
  if (fallbackText !== undefined && typeof fallbackText !== "string") return undefined;
  return {
    egressId: record["egressId"],
    target: record["target"] as TTarget,
    replies: record["replies"],
    ...(fallbackText !== undefined ? { fallbackText } : {}),
    queuedAt: record["queuedAt"],
  };
}

async function listEvents(events: EventStore, options?: PendingEgressOptions): Promise<DurableEvent[]> {
  if (options?.workId !== undefined) return await events.listByWork(options.workId);
  if (options?.sessionId !== undefined) return await events.listBySession(options.sessionId);
  return await events.list();
}

/** Durable egress outbox backed by v4 events. */
export class EgressOutbox {
  private readonly _events: EventStore;

  /** Creates an egress outbox. */
  constructor(events: EventStore) {
    this._events = events;
  }

  /** Appends an egress.queued event and returns the queued payload. */
  async queue<TTarget = unknown>(
    input: QueueEgressInput<TTarget>,
  ): Promise<{ event: DurableEvent; payload: QueuedEgressPayload<TTarget> }> {
    const payload: QueuedEgressPayload<TTarget> = {
      egressId: input.egressId ?? crypto.randomUUID(),
      target: input.target,
      replies: [...input.replies],
      ...(input.fallbackText !== undefined ? { fallbackText: input.fallbackText } : {}),
      queuedAt: (input.now ?? new Date()).toISOString(),
    };
    const event = await this._events.append({
      category: "egress.queued",
      workId: input.workId,
      sessionId: input.sessionId,
      payload,
    });
    return { event, payload };
  }

  /** Appends an egress.sent event for a queued payload. */
  async markSent<TTarget = unknown>(
    input: MarkEgressSentInput<TTarget>,
  ): Promise<{ event: DurableEvent; payload: SentEgressPayload<TTarget> }> {
    const payload: SentEgressPayload<TTarget> = {
      ...input.payload,
      sentAt: (input.now ?? new Date()).toISOString(),
    };
    const event = await this._events.append({
      category: "egress.sent",
      workId: input.workId,
      sessionId: input.sessionId,
      payload,
    });
    return { event, payload };
  }

  /** Appends an egress.dropped event for a queued payload. */
  async markDropped<TTarget = unknown>(
    input: MarkEgressDroppedInput<TTarget>,
  ): Promise<{ event: DurableEvent; payload: DroppedEgressPayload<TTarget> }> {
    const payload: DroppedEgressPayload<TTarget> = {
      ...input.payload,
      droppedAt: (input.now ?? new Date()).toISOString(),
      reason: input.reason,
    };
    const event = await this._events.append({
      category: "egress.dropped",
      workId: input.workId,
      sessionId: input.sessionId,
      payload,
    });
    return { event, payload };
  }

  /** Replays events and returns queued egress with no matching terminal event. */
  async listPending<TTarget = unknown>(options?: PendingEgressOptions): Promise<PendingEgress<TTarget>[]> {
    const pending = new Map<string, PendingEgress<TTarget>>();
    for (const event of await listEvents(this._events, options)) {
      if (event.category === "egress.queued") {
        const payload = queuedPayload<TTarget>(event.payload);
        if (payload) pending.set(egressKey(event, payload.egressId), { event, payload });
      } else if (event.category === "egress.sent" || event.category === "egress.dropped") {
        const id = egressId(event.payload);
        if (id) pending.delete(egressKey(event, id));
      }
    }
    return [...pending.values()].sort((a, b) => a.event.sequence - b.event.sequence);
  }
}
