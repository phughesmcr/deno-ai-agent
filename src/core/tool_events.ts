import type { EventStore } from "./events.ts";

/** Structural observer for model-act callbacks that involve tool calls. */
export interface ToolLifecycleObserver {
  /** Records an assistant/model message. */
  onMessage(): void;
  /** Records first token timing. */
  onFirstToken(roundIndex: number, ms?: number): void;
  /** Records a model round start. */
  onRoundStart(roundIndex: number): void;
  /** Records a model round end. */
  onRoundEnd(roundIndex: number): void;
  /** Records the start of a streamed tool-call request. */
  onToolCallRequestStart(roundIndex: number, callId: number, toolCallId?: string): void;
  /** Records the resolved tool name. */
  onToolCallRequestNameReceived(callId: number, name: string): void;
  /** Records completion of the tool-call request envelope. */
  onToolCallRequestEnd(roundIndex: number, callId: number, name: string, isQueued: boolean): void;
  /** Records tool-call request failure. */
  onToolCallRequestFailure(callId: number, message: string): void;
  /** Records completed tool-call execution. */
  onToolCallRequestFinalized(callId: number, name: string): void;
  /** Records dequeue of a queued tool-call execution. */
  onToolCallRequestDequeued(roundIndex: number, callId: number): void;
}

/** Tool request event payload. */
export interface ToolRequestedPayload {
  /** Model round index. */
  roundIndex: number;
  /** SDK-local numeric call id. */
  callId: number;
  /** Provider tool-call id, when supplied. */
  toolCallId?: string;
  /** Tool name. */
  name: string;
  /** Whether the SDK queued execution behind other tool calls. */
  isQueued: boolean;
  /** ISO timestamp for the durable request event. */
  requestedAt: string;
}

/** Tool completion event payload. */
export interface ToolCompletedPayload {
  /** Model round index, when known. */
  roundIndex?: number;
  /** SDK-local numeric call id. */
  callId: number;
  /** Provider tool-call id, when supplied. */
  toolCallId?: string;
  /** Tool name, when known. */
  name?: string;
  /** Terminal tool-call status. */
  status: "completed" | "failed";
  /** Error message for failed requests. */
  error?: string;
  /** ISO timestamp for the durable completion event. */
  completedAt: string;
}

/** Model round-start event payload. */
export interface ModelRoundStartedPayload {
  /** Model-act round index supplied by the model adapter. */
  roundIndex: number;
  /** Event sequence projected into model context before the turn started. */
  projectedThroughSequence?: number;
  /** ISO timestamp for the durable round-start event. */
  startedAt: string;
}

/** Options for durable tool lifecycle event recording. */
export interface DurableToolEventObserverOptions {
  /** Durable event store. */
  events: EventStore;
  /** Current session id. */
  sessionId: string;
  /** Active work id. */
  workId: string;
  /** Event sequence projected into model context before the turn started. */
  projectedThroughSequence?: number;
  /** Deterministic clock for tests. */
  now?: () => Date;
}

/** Tool lifecycle observer with a flush method for pending event writes. */
export interface DurableToolEventObserver extends ToolLifecycleObserver {
  /** Ensures a round-start event exists when an adapter lacks round callbacks. */
  ensureRoundStarted(roundIndex: number): void;
  /** Waits for all scheduled durable writes to finish. */
  flush(): Promise<void>;
}

interface ToolCallState {
  roundIndex?: number;
  toolCallId?: string;
  name?: string;
  requested: boolean;
  completed: boolean;
}

function noop(): void {}

/** Combines multiple model-act observers into one structural observer. */
export function composeToolLifecycleObservers(
  observers: readonly (ToolLifecycleObserver | undefined)[],
): ToolLifecycleObserver {
  const active = observers.filter((observer): observer is ToolLifecycleObserver => observer !== undefined);
  return {
    onMessage(): void {
      for (const observer of active) observer.onMessage();
    },
    onFirstToken(roundIndex: number, ms?: number): void {
      for (const observer of active) observer.onFirstToken(roundIndex, ms);
    },
    onRoundStart(roundIndex: number): void {
      for (const observer of active) observer.onRoundStart(roundIndex);
    },
    onRoundEnd(roundIndex: number): void {
      for (const observer of active) observer.onRoundEnd(roundIndex);
    },
    onToolCallRequestStart(roundIndex: number, callId: number, toolCallId?: string): void {
      for (const observer of active) observer.onToolCallRequestStart(roundIndex, callId, toolCallId);
    },
    onToolCallRequestNameReceived(callId: number, name: string): void {
      for (const observer of active) observer.onToolCallRequestNameReceived(callId, name);
    },
    onToolCallRequestEnd(roundIndex: number, callId: number, name: string, isQueued: boolean): void {
      for (const observer of active) observer.onToolCallRequestEnd(roundIndex, callId, name, isQueued);
    },
    onToolCallRequestFailure(callId: number, message: string): void {
      for (const observer of active) observer.onToolCallRequestFailure(callId, message);
    },
    onToolCallRequestFinalized(callId: number, name: string): void {
      for (const observer of active) observer.onToolCallRequestFinalized(callId, name);
    },
    onToolCallRequestDequeued(roundIndex: number, callId: number): void {
      for (const observer of active) observer.onToolCallRequestDequeued(roundIndex, callId);
    },
  };
}

/** Creates an observer that persists durable v4 round and tool lifecycle events. */
export function createDurableToolEventObserver(
  options: DurableToolEventObserverOptions,
): DurableToolEventObserver {
  const now = options.now ?? (() => new Date());
  const states = new Map<number, ToolCallState>();
  const startedRounds = new Set<number>();
  let queue: Promise<void> = Promise.resolve();

  function stateFor(callId: number): ToolCallState {
    const current = states.get(callId);
    if (current) return current;
    const created: ToolCallState = { requested: false, completed: false };
    states.set(callId, created);
    return created;
  }

  function append(
    category: "model.round.started" | "tool.requested" | "tool.completed",
    payload: ModelRoundStartedPayload | ToolRequestedPayload | ToolCompletedPayload,
  ): void {
    queue = queue.then(async () => {
      await options.events.append({
        category,
        workId: options.workId,
        sessionId: options.sessionId,
        payload,
      });
    });
  }

  function appendRoundStarted(roundIndex: number): void {
    if (startedRounds.has(roundIndex)) return;
    startedRounds.add(roundIndex);
    append("model.round.started", {
      roundIndex,
      ...(options.projectedThroughSequence !== undefined ?
        { projectedThroughSequence: options.projectedThroughSequence } :
        {}),
      startedAt: now().toISOString(),
    });
  }

  function appendRequested(callId: number, roundIndex: number, name: string, isQueued: boolean): void {
    const state = stateFor(callId);
    state.roundIndex = roundIndex;
    state.name = name;
    if (state.requested) return;
    state.requested = true;
    append("tool.requested", {
      roundIndex,
      callId,
      ...(state.toolCallId !== undefined ? { toolCallId: state.toolCallId } : {}),
      name,
      isQueued,
      requestedAt: now().toISOString(),
    });
  }

  function appendCompleted(callId: number, status: "completed" | "failed", name?: string, error?: string): void {
    const state = stateFor(callId);
    if (name !== undefined) state.name = name;
    if (state.completed) return;
    state.completed = true;
    append("tool.completed", {
      ...(state.roundIndex !== undefined ? { roundIndex: state.roundIndex } : {}),
      callId,
      ...(state.toolCallId !== undefined ? { toolCallId: state.toolCallId } : {}),
      ...(state.name !== undefined ? { name: state.name } : {}),
      status,
      ...(error !== undefined ? { error } : {}),
      completedAt: now().toISOString(),
    });
  }

  return {
    onMessage: noop,
    onFirstToken: noop,
    onRoundStart(roundIndex: number): void {
      appendRoundStarted(roundIndex);
    },
    onRoundEnd: noop,
    onToolCallRequestStart(roundIndex: number, callId: number, toolCallId?: string): void {
      const state = stateFor(callId);
      state.roundIndex = roundIndex;
      if (toolCallId !== undefined) state.toolCallId = toolCallId;
    },
    onToolCallRequestNameReceived(callId: number, name: string): void {
      stateFor(callId).name = name;
    },
    onToolCallRequestEnd(roundIndex: number, callId: number, name: string, isQueued: boolean): void {
      appendRequested(callId, roundIndex, name, isQueued);
    },
    onToolCallRequestFailure(callId: number, message: string): void {
      appendCompleted(callId, "failed", undefined, message);
    },
    onToolCallRequestFinalized(callId: number, name: string): void {
      appendCompleted(callId, "completed", name);
    },
    onToolCallRequestDequeued(roundIndex: number, callId: number): void {
      stateFor(callId).roundIndex = roundIndex;
    },
    ensureRoundStarted(roundIndex: number): void {
      appendRoundStarted(roundIndex);
    },
    async flush(): Promise<void> {
      await queue;
    },
  };
}
