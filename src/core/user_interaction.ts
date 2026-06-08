import type { DurableEvent, EventStore } from "./events.ts";

/** Active interaction context forwarded to an adapter-specific interaction port. */
export interface DurableInteractionTurnTarget<TContext = unknown> {
  /** Adapter context for the active turn. */
  ctx: TContext;
  /** Abort signal for the active turn. */
  signal: AbortSignal;
}

/** Structural user-interaction port wrapped by the durable core. */
export interface DurableUserInteractionPort<TContext = unknown, TRequest = unknown, TResult = unknown> {
  /** Whether an interactive channel is available for the active adapter. */
  isAvailable(): boolean;
  /** Whether the adapter currently waits for a user response. */
  isPending(): boolean;
  /** Sets adapter-specific turn context. */
  setTurnContext(target: DurableInteractionTurnTarget<TContext>): void;
  /** Clears adapter-specific turn context. */
  clearTurnContext(): void;
  /** Requests user interaction and returns the adapter result. */
  interact(request: TRequest): Promise<TResult>;
  /** Resolves when a URL elicitation completes, when supported by the adapter. */
  waitForUrlElicitationComplete?(elicitationId: string, signal: AbortSignal): Promise<void>;
  /** Notifies URL elicitation completion, when supported by the adapter. */
  notifyUrlElicitationComplete?(elicitationId: string): void;
}

/** Options for durable interaction event wrapping. */
export interface DurableInteractionPortOptions<TContext = unknown, TRequest = unknown, TResult = unknown> {
  /** Durable event store. */
  events: EventStore;
  /** Existing adapter interaction port. */
  delegate: DurableUserInteractionPort<TContext, TRequest, TResult>;
  /** Resolves the active session id at request time. */
  getSessionId: () => string;
  /** Resolves the active work id at request time, when any. */
  getWorkId?: () => string | undefined;
  /** Deterministic clock for tests. */
  now?: () => Date;
  /** Deterministic interaction id source for tests. */
  createInteractionId?: () => string;
}

/** Durable payload for an interaction request event. */
export interface InteractionRequestedPayload<TRequest = unknown> {
  /** Stable id correlating request and completion. */
  interactionId: string;
  /** Adapter request payload. */
  request: TRequest;
  /** ISO timestamp when the wrapper accepted the request. */
  requestedAt: string;
}

/** Durable payload for an interaction completion event. */
export interface InteractionCompletedPayload<TResult = unknown> {
  /** Stable id correlating request and completion. */
  interactionId: string;
  /** Completion status. */
  status: "completed" | "failed";
  /** Adapter result for successful interactions. */
  result?: TResult;
  /** Serialized error for failed interactions. */
  error?: { name?: string; message: string };
  /** ISO timestamp when the wrapper observed completion. */
  completedAt: string;
}

/** A requested interaction that has no matching completion event. */
export interface PendingInteraction<TRequest = unknown> {
  /** Stable id correlating request and future completion. */
  interactionId: string;
  /** Work item associated with the request, when any. */
  workId?: string;
  /** Session associated with the request, when any. */
  sessionId?: string;
  /** Adapter request payload. */
  request: TRequest;
  /** Durable event that requested the interaction. */
  requestedEvent: DurableEvent;
}

/** Filters for replaying pending interactions. */
export interface PendingInteractionListOptions {
  /** Restrict replay to one work item. */
  workId?: string;
  /** Restrict replay to one session. */
  sessionId?: string;
}

function errorPayload(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    return {
      ...(error.name ? { name: error.name } : {}),
      message: error.message,
    };
  }
  return { message: String(error) };
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  return payload as Record<string, unknown>;
}

function interactionIdFromPayload(payload: unknown): string | undefined {
  const record = payloadRecord(payload);
  return typeof record?.["interactionId"] === "string" ? record["interactionId"] : undefined;
}

async function listInteractionEvents(
  events: EventStore,
  options?: PendingInteractionListOptions,
): Promise<DurableEvent[]> {
  if (options?.workId !== undefined) return await events.listByWork(options.workId);
  if (options?.sessionId !== undefined) return await events.listBySession(options.sessionId);
  return await events.list();
}

/** Wraps a user-interaction port with durable request and completion events. */
export function createDurableUserInteractionPort<TContext = unknown, TRequest = unknown, TResult = unknown>(
  options: DurableInteractionPortOptions<TContext, TRequest, TResult>,
): DurableUserInteractionPort<TContext, TRequest, TResult> {
  const now = options.now ?? (() => new Date());
  const createInteractionId = options.createInteractionId ?? (() => crypto.randomUUID());

  return {
    isAvailable(): boolean {
      return options.delegate.isAvailable();
    },
    isPending(): boolean {
      return options.delegate.isPending();
    },
    setTurnContext(target: DurableInteractionTurnTarget<TContext>): void {
      options.delegate.setTurnContext(target);
    },
    clearTurnContext(): void {
      options.delegate.clearTurnContext();
    },
    waitForUrlElicitationComplete(
      elicitationId: string,
      signal: AbortSignal,
    ): Promise<void> {
      if (!options.delegate.waitForUrlElicitationComplete) {
        return Promise.reject(new Error("URL elicitation completion is not supported by this interaction port."));
      }
      return options.delegate.waitForUrlElicitationComplete(elicitationId, signal);
    },
    notifyUrlElicitationComplete(elicitationId: string): void {
      options.delegate.notifyUrlElicitationComplete?.(elicitationId);
    },
    async interact(request: TRequest): Promise<TResult> {
      const sessionId = options.getSessionId();
      const workId = options.getWorkId?.();
      const interactionId = createInteractionId();

      await options.events.append({
        category: "interaction.requested",
        workId,
        sessionId,
        payload: {
          interactionId,
          request,
          requestedAt: now().toISOString(),
        } satisfies InteractionRequestedPayload<TRequest>,
      });

      try {
        const result = await options.delegate.interact(request);
        await options.events.append({
          category: "interaction.completed",
          workId,
          sessionId,
          payload: {
            interactionId,
            status: "completed",
            result,
            completedAt: now().toISOString(),
          } satisfies InteractionCompletedPayload<TResult>,
        });
        return result;
      } catch (error) {
        await options.events.append({
          category: "interaction.completed",
          workId,
          sessionId,
          payload: {
            interactionId,
            status: "failed",
            error: errorPayload(error),
            completedAt: now().toISOString(),
          } satisfies InteractionCompletedPayload<TResult>,
        });
        throw error;
      }
    },
  };
}

/** Replays durable events and returns interactions with no matching completion. */
export async function listPendingInteractions<TRequest = unknown>(
  events: EventStore,
  options?: PendingInteractionListOptions,
): Promise<PendingInteraction<TRequest>[]> {
  const pending = new Map<string, PendingInteraction<TRequest>>();
  const durableEvents = await listInteractionEvents(events, options);

  for (const event of durableEvents) {
    if (event.category !== "interaction.requested" && event.category !== "interaction.completed") continue;
    const interactionId = interactionIdFromPayload(event.payload);
    if (!interactionId) continue;

    if (event.category === "interaction.requested") {
      const payload = payloadRecord(event.payload);
      pending.set(interactionId, {
        interactionId,
        ...(event.workId !== undefined ? { workId: event.workId } : {}),
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
        request: payload?.["request"] as TRequest,
        requestedEvent: event,
      });
    } else {
      pending.delete(interactionId);
    }
  }

  return [...pending.values()].sort((a, b) => a.requestedEvent.sequence - b.requestedEvent.sequence);
}
