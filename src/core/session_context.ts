import type { ChatMessageData, Tool } from "@lmstudio/sdk";

import type { DurableEvent, EventStore } from "./events.ts";
import type { ModelActObserver, ModelTurnOutput, ModelTurnPort, ToolCallGuard } from "./model_turn.ts";
import { composeToolLifecycleObservers, createDurableToolEventObserver } from "./tool_events.ts";
import { logDebug } from "../shared/log.ts";
import { traceSpan } from "../shared/otel.ts";

/**
 * Projected model context for a durable session.
 * @internal
 */
export interface SessionContextProjection {
  /** Session id. */
  sessionId: string;
  /** System prompt augmented with latest compaction summary. */
  systemPrompt: string;
  /** Replayable chat messages after the latest compaction checkpoint. */
  messages: ChatMessageData[];
  /** Latest compaction summary, when present. */
  compactionSummary?: string;
  /** Last event sequence used for the projection. */
  lastSequence: number;
}

/**
 * Request for a durable model turn over session context.
 * @internal
 */
export interface SessionContextRunModelTurnRequest {
  /** Session id for event correlation and projection. */
  sessionId: string;
  /** Work id for event correlation. */
  workId: string;
  /** Payload persisted in the `turn.input` event. */
  inputPayload: unknown;
  /** Whether to append a new input or preserve an already-persisted one for this work item. */
  inputPolicy?: "append" | "ensure";
  /** Current system prompt used for projection. */
  baseSystemPrompt: string;
  /** Tools available to the model. */
  tools: Tool[];
  /** App-level guard for approving or denying model tool calls. */
  guardToolCall?: ToolCallGuard;
  /** Signal that cancels model execution. */
  signal: AbortSignal;
  /** Optional telemetry observer composed with durable tool lifecycle persistence. */
  observer?: ModelActObserver;
  /** Optional hook invoked before each assistant message is persisted. */
  onModelMessage?: (message: ChatMessageData) => void | Promise<void>;
}

/** Cumulative file context included in a compaction checkpoint. */
export interface SessionFileDetails {
  /** Files read during the session, when recoverable from tool calls. */
  readFiles: string[];
  /** Files modified during the session, when recoverable from tool calls. */
  modifiedFiles: string[];
}

/**
 * Input for generating an updated structured context checkpoint.
 * @internal
 */
export interface SummaryCompactionInput {
  /** Current system prompt to apply while asking the model for a summary. */
  systemPrompt: string;
  /** Previous checkpoint summary, when this compaction updates an earlier checkpoint. */
  previousSummary?: string;
  /** Raw message data to fold into the checkpoint. */
  messages: ChatMessageData[];
  /** Optional user-supplied manual compaction instructions. */
  instructions?: string;
  /** Cumulative file context to include in the checkpoint. */
  details: SessionFileDetails;
}

/** Port for generating structured context checkpoints. */
export interface ContextSummaryPort {
  /** Generates an updated structured context checkpoint. */
  summarize(input: SummaryCompactionInput): Promise<string>;
}

/** Result of a compaction attempt. */
export interface SessionCompactionResult {
  /** Whether a checkpoint entry was appended. */
  compacted: boolean;
  /** Estimated context tokens before the attempt. */
  beforeTokens: number;
  /** Estimated context tokens after the attempt. */
  afterTokens: number;
  /** Why compaction was attempted. */
  reason: "auto" | "manual";
}

/** Current projected context count. */
export interface SessionContextCount {
  /** Estimated context tokens for system prompt plus projected messages. */
  tokenCount: number;
  /** System prompt plus projected message count. */
  messageCount: number;
}

/** Result of token accounting and optional automatic compaction after a turn. */
export interface FinalizeSessionTurnResult {
  /** Whether an automatic compaction checkpoint was appended. */
  compacted: boolean;
  /** Estimated context tokens after finalization. */
  totalTokens: number;
  /** System prompt plus projected message count after finalization. */
  messageCount: number;
}

/** Request for manual or automatic compaction. */
export interface SessionContextCompactionRequest {
  /** Session to compact. */
  sessionId: string;
  /** Current base system prompt. */
  baseSystemPrompt: string;
  /** Why compaction is being attempted. */
  reason: "auto" | "manual";
  /** Optional manual compaction instructions. */
  instructions?: string;
  /** Already-counted pre-compaction tokens, when available. */
  beforeTokens?: number;
}

/** Result of compaction with post-compaction message count. */
export interface SessionContextCompactionResult extends SessionCompactionResult {
  /** System prompt plus projected message count after compaction. */
  messageCount: number;
}

/** Construction options for {@link SessionContextEngine}. */
export interface SessionContextEngineOptions {
  /** Durable event store. */
  events: EventStore;
  /** Model turn and token-counting port. */
  model: ModelTurnPort;
  /** Summary generator for compaction checkpoints. */
  summary: ContextSummaryPort;
  /** Model context window size. */
  maxContextLength: number;
  /** Reserved output/context headroom before auto-compaction. */
  reserveTokens?: number;
}

const DEFAULT_RESERVE_TOKEN_RATIO = 0.25;

function percentageTokens(maxContextLength: number, ratio: number): number {
  if (!Number.isFinite(maxContextLength) || maxContextLength <= 0) return 1;
  return Math.max(1, Math.floor(maxContextLength * ratio));
}

function textMessageData(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return { role, content: [{ type: "text", text }] } as ChatMessageData;
}

function objectPayload(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

function textFromInputPayload(payload: unknown): string | null {
  const record = objectPayload(payload);
  if (!record) return null;
  const directText = record["text"];
  if (typeof directText === "string") return directText;
  const input = objectPayload(record["input"]);
  const inputText = input?.["text"];
  return typeof inputText === "string" ? inputText : null;
}

function isChatMessageData(value: unknown): value is ChatMessageData {
  const record = objectPayload(value);
  return typeof record?.["role"] === "string" && Array.isArray(record["content"]);
}

function messageFromPayload(payload: unknown): ChatMessageData | null {
  const record = objectPayload(payload);
  const message = record?.["message"];
  return isChatMessageData(message) ? message : null;
}

function summaryFromPayload(payload: unknown): string | null {
  const record = objectPayload(payload);
  const summary = record?.["summary"];
  return typeof summary === "string" ? summary : null;
}

function systemPromptWithSummary(baseSystemPrompt: string, summary: string | null): string {
  if (!summary) return baseSystemPrompt;
  return `${baseSystemPrompt}\n\nCompacted session context:\n${summary}`;
}

function latestCompaction(events: DurableEvent[]): DurableEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.category === "session.compacted") return event;
  }
  return null;
}

function emptyDetails(): SessionFileDetails {
  return { readFiles: [], modifiedFiles: [] };
}

/** Event-sourced session context engine for projection, durable turns, token counts, and compaction. */
export class SessionContextEngine {
  private readonly _events: EventStore;
  private readonly _model: ModelTurnPort;
  private readonly _summary: ContextSummaryPort;
  private readonly _maxContextLength: number;
  private readonly _reserveTokens: number;

  /** Creates a session context engine. */
  constructor(options: SessionContextEngineOptions) {
    this._events = options.events;
    this._model = options.model;
    this._summary = options.summary;
    this._maxContextLength = options.maxContextLength;
    this._reserveTokens = options.reserveTokens ??
      percentageTokens(options.maxContextLength, DEFAULT_RESERVE_TOKEN_RATIO);
  }

  /** Projects a session into a model-ready context. */
  async project(request: { sessionId: string; baseSystemPrompt: string }): Promise<SessionContextProjection> {
    const events = await this._events.listBySession(request.sessionId);
    const compaction = latestCompaction(events);
    const messages: ChatMessageData[] = [];
    for (const event of events) {
      if (compaction && event.sequence <= compaction.sequence) continue;
      if (event.category === "turn.input") {
        const message = messageFromPayload(event.payload);
        if (message) {
          messages.push(message);
          continue;
        }
        const text = textFromInputPayload(event.payload);
        if (text !== null) messages.push(textMessageData("user", text));
      } else if (event.category === "model.message") {
        const message = messageFromPayload(event.payload);
        if (message) messages.push(message);
      }
    }

    const summary = compaction ? summaryFromPayload(compaction.payload) : null;
    return {
      sessionId: request.sessionId,
      systemPrompt: systemPromptWithSummary(request.baseSystemPrompt, summary),
      messages,
      ...(summary ? { compactionSummary: summary } : {}),
      lastSequence: events.at(-1)?.sequence ?? 0,
    };
  }

  /** Runs one durable model turn over a projected session context. */
  async runModelTurn(request: SessionContextRunModelTurnRequest): Promise<ModelTurnOutput> {
    await this._persistTurnInput(request);
    const projection = await this.project({
      sessionId: request.sessionId,
      baseSystemPrompt: request.baseSystemPrompt,
    });

    const toolObserver = createDurableToolEventObserver({
      events: this._events,
      sessionId: request.sessionId,
      workId: request.workId,
      projectedThroughSequence: projection.lastSequence,
    });
    const observer = composeToolLifecycleObservers([request.observer, toolObserver]);
    toolObserver.ensureRoundStarted(0);
    const output = await (async () => {
      try {
        return await this._model.run({
          systemPrompt: projection.systemPrompt,
          messages: projection.messages,
          tools: request.tools,
          guardToolCall: request.guardToolCall,
          signal: request.signal,
          observer,
        });
      } finally {
        await toolObserver.flush();
      }
    })();

    for (const message of output.persistedMessages) {
      await request.onModelMessage?.(message);
      await this._events.append({
        category: "model.message",
        workId: request.workId,
        sessionId: request.sessionId,
        payload: { message },
      });
    }

    return output;
  }

  /** Counts the current projected context. */
  async countContext(request: { sessionId: string; baseSystemPrompt: string }): Promise<SessionContextCount> {
    const projection = await this.project(request);
    const messages = [
      textMessageData("system", projection.systemPrompt),
      ...projection.messages,
    ];
    const counts = await this._model.countTokens(messages);
    return {
      tokenCount: counts.reduce((sum, count) => sum + count, 0),
      messageCount: messages.length,
    };
  }

  /** Counts and auto-compacts the session when the reserve threshold is exceeded. */
  async finalizeTurn(request: { sessionId: string; baseSystemPrompt: string }): Promise<FinalizeSessionTurnResult> {
    const before = await this.countContext(request);
    if (before.tokenCount <= this._maxContextLength - this._reserveTokens) {
      return {
        compacted: false,
        totalTokens: before.tokenCount,
        messageCount: before.messageCount,
      };
    }

    const compaction = await this.compact({
      ...request,
      reason: "auto",
      beforeTokens: before.tokenCount,
    });
    return {
      compacted: compaction.compacted,
      totalTokens: compaction.afterTokens,
      messageCount: compaction.messageCount,
    };
  }

  /** Appends a manual or automatic compaction checkpoint when there are projected messages to summarize. */
  async compact(request: SessionContextCompactionRequest): Promise<SessionContextCompactionResult> {
    return await traceSpan("context.compact", async (span) => {
      const before = request.beforeTokens ??
        (await this.countContext(request)).tokenCount;
      const projection = await this.project({
        sessionId: request.sessionId,
        baseSystemPrompt: request.baseSystemPrompt,
      });
      if (projection.messages.length === 0) {
        return {
          compacted: false,
          beforeTokens: before,
          afterTokens: before,
          reason: request.reason,
          messageCount: 1,
        };
      }

      const summary = await this._summary.summarize({
        systemPrompt: request.baseSystemPrompt,
        previousSummary: projection.compactionSummary,
        messages: projection.messages,
        instructions: request.instructions,
        details: emptyDetails(),
      });
      await this._events.append({
        category: "session.compacted",
        sessionId: request.sessionId,
        payload: { summary, reason: request.reason, tokensBefore: before },
      });

      const after = await this.countContext(request);
      span.setAttributes({
        "context.tokens.before": before,
        "context.tokens.after": after.tokenCount,
      });
      logDebug("context.compact", {
        before,
        after: after.tokenCount,
        reason: request.reason,
      });
      return {
        compacted: true,
        beforeTokens: before,
        afterTokens: after.tokenCount,
        reason: request.reason,
        messageCount: after.messageCount,
      };
    });
  }

  /** Persists the turn input when the request policy requires it. */
  private async _persistTurnInput(request: SessionContextRunModelTurnRequest): Promise<void> {
    if (!await this._shouldAppendTurnInput(request)) return;
    await this._events.append({
      category: "turn.input",
      workId: request.workId,
      sessionId: request.sessionId,
      payload: request.inputPayload,
    });
  }

  /** Returns whether a turn input should be appended for the request policy. */
  private async _shouldAppendTurnInput(request: SessionContextRunModelTurnRequest): Promise<boolean> {
    if ((request.inputPolicy ?? "append") === "append") return true;
    const existing = await this._events.listByWork(request.workId);
    return !existing.some((event) => event.category === "turn.input");
  }
}
