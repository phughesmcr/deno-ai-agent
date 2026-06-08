import type { ChatMessageData, Tool } from "@lmstudio/sdk";

/** Model tool-call request shape used by LM Studio's guard hook. */
export interface GuardedToolCallRequest {
  /** SDK tool-call id, when available. */
  id?: string;
  /** Requested tool name. */
  name: string;
  /** Requested tool arguments. */
  arguments?: Record<string, unknown>;
}

/** Small structural subset of LM Studio's non-exported guard controller. */
export interface ToolCallGuardController {
  /** Tool-call request being guarded. */
  readonly toolCallRequest: GuardedToolCallRequest;
  /** Allows the tool call unchanged. */
  allow(): void;
  /** Denies the tool call with an optional model-visible reason. */
  deny(reason?: string): void;
  /** Allows the tool call with replacement parameters. */
  allowAndOverrideParameters(newParameters: Record<string, unknown>): void;
}

/** App-level guard function passed to the model act boundary. */
export type ToolCallGuard = (
  roundIndex: number,
  callId: number,
  controller: ToolCallGuardController,
) => void | Promise<void>;

/** Telemetry hooks for the model act lifecycle. */
export interface ModelActObserver {
  /** Records an assistant message event. */
  onMessage(): void;
  /** Records time to first token for a round. */
  onFirstToken(roundIndex: number, ms?: number): void;
  /** Starts a span for an act round. */
  onRoundStart(roundIndex: number): void;
  /** Ends the span for an act round. */
  onRoundEnd(roundIndex: number): void;
  /** Starts a span when the model requests a tool call. */
  onToolCallRequestStart(roundIndex: number, callId: number, toolCallId?: string): void;
  /** Records the resolved tool name for a pending call. */
  onToolCallRequestNameReceived(callId: number, name: string): void;
  /** Records that a tool call request finished streaming. */
  onToolCallRequestEnd(roundIndex: number, callId: number, name: string, isQueued: boolean): void;
  /** Ends a tool call span after a request failure. */
  onToolCallRequestFailure(callId: number, message: string): void;
  /** Ends the span after a request is finalized. */
  onToolCallRequestFinalized(callId: number, name: string): void;
  /** Records that a queued tool call started executing. */
  onToolCallRequestDequeued(roundIndex: number, callId: number): void;
}

/**
 * Request passed from orchestration to a model adapter.
 * @internal
 */
export interface ModelTurnRequest {
  /** Current system prompt, supplied out-of-band from persisted messages. */
  systemPrompt: string;
  /** Projected visible context, excluding the system prompt. */
  messages: ChatMessageData[];
  /** Tools available to the model during this turn. */
  tools: Tool[];
  /** App-level guard for approving or denying model tool calls. */
  guardToolCall?: ToolCallGuard;
  /** Signal that cancels the active turn. */
  signal: AbortSignal;
  /** Optional telemetry observer for model callback events. */
  observer?: ModelActObserver;
}

/**
 * Output returned by a model adapter after one turn.
 * @internal
 */
export interface ModelTurnOutput {
  /** Messages to append to the durable session log. */
  persistedMessages: ChatMessageData[];
  /** User-visible assistant text, before persistence-specific stripping. */
  replyTexts: string[];
  /** Time to first model token, when one was observed. */
  firstTokenMs?: number;
}

/**
 * Adapter boundary for model turns and token counting.
 * @internal
 */
export interface ModelTurnPort {
  /** Runs one model turn over an already-projected session context. */
  run(request: ModelTurnRequest): Promise<ModelTurnOutput>;
  /** Counts tokens for each message in order. */
  countTokens(messages: ChatMessageData[]): Promise<number[]>;
}
