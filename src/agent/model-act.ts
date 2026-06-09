import {
  Chat,
  type ChatMessage,
  type ChatMessageData,
  type LLM,
  type LMStudioClient,
  type Tool,
  type ToolCallRequest,
} from "@lmstudio/sdk";

import type { ModelActObserver, ModelTurnOutput, ModelTurnPort, ModelTurnRequest } from "../core/mod.ts";
import {
  cronExtractionPrompt,
  type CronScheduleExtractionRequest,
  type CronScheduleExtractor,
  cronScheduleJsonSchema,
  parseRawExtractedCronSchedule,
  type RawExtractedCronSchedule,
} from "../cron/schedule.ts";
import { getActMaxPredictionRounds } from "../shared/act-config.ts";
import { getActDraftModel } from "../shared/draft-model.ts";
import { actReasoningParsingOption, persistedModelText } from "../shared/reasoning.ts";
import { prepareSummaryCompaction, type SummaryCompactionInput } from "./context/compactor.ts";
import { materializeMessageForChat } from "./context/message-materialize.ts";
import { chatMessageForPersistence } from "./context/persisted-message.ts";
import type { ContextSummaryPort } from "./context/session.ts";

/** @internal SDK exposes getRaw() at runtime but not in public types. */
type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

/** Request for a read-only subagent model act. */
export interface SubagentActRequest {
  /** System prompt for the subagent role. */
  systemPrompt: string;
  /** User task prompt. */
  task: string;
  /** Read-only tools available to the subagent. */
  tools: Tool[];
  /** Signal that cancels the active subagent act. */
  signal: AbortSignal;
  /** Optional telemetry observer for model callback events. */
  observer?: ModelActObserver;
}

/** Result of a read-only subagent model act. */
export interface SubagentActResult {
  /** Final assistant text with persistence reasoning policy applied. */
  text: string;
}

/** Unified model-act boundary for normal turns, compaction summaries, and subagents. */
export interface AgentModelActPort extends ModelTurnPort, ContextSummaryPort, CronScheduleExtractor {
  /** Runs one read-only subagent turn. */
  runSubagent(request: SubagentActRequest): Promise<SubagentActResult>;
}

/** Options for {@link LmStudioAgentModelAct}. */
export interface LmStudioAgentModelActOptions {
  /** Connected LM Studio client used to materialize persisted chat messages. */
  client: LMStudioClient;
  /** Loaded LM Studio language model. */
  model: LLM;
  /** Optional process-level signal for summary acts. */
  signal?: AbortSignal;
  /** Maximum characters of each tool result included in summary prompts. */
  summaryToolResultLimit?: number;
}

function messageToData(message: ChatMessage): ChatMessageData {
  return (message as ChatMessageWithRaw).getRaw();
}

function toolRequests(message: ChatMessageData): ToolCallRequest[] {
  return message.content.flatMap((part) => part.type === "toolCallRequest" ? [part.toolCallRequest] : []);
}

function isUserVisibleAssistantReply(message: ChatMessageData): boolean {
  return message.role === "assistant" && toolRequests(message).length === 0;
}

function parseStructuredJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Cron schedule extractor returned non-JSON text.");
  }
}

function appendMessages(client: LMStudioClient, chat: Chat, messages: ChatMessageData[]): void {
  for (const message of messages) {
    chat.append(materializeMessageForChat(client, message));
  }
}

function actObserverCallbacks(
  observer: ModelActObserver | undefined,
  actStarted: number,
): {
  firstTokenMs: () => number | undefined;
  callbacks: {
    onFirstToken: (roundIndex: number) => void;
    onRoundStart: (roundIndex: number) => void;
    onRoundEnd: (roundIndex: number) => void;
    onToolCallRequestDequeued: (roundIndex: number, callId: number) => void;
    onToolCallRequestEnd: (
      roundIndex: number,
      callId: number,
      info: { toolCallRequest: ToolCallRequest; isQueued: boolean },
    ) => void;
    onToolCallRequestFailure: (_roundIndex: number, callId: number, error: Error) => void;
    onToolCallRequestFinalized: (
      _roundIndex: number,
      callId: number,
      info: { toolCallRequest: ToolCallRequest },
    ) => void;
    onToolCallRequestNameReceived: (_roundIndex: number, callId: number, name: string) => void;
    onToolCallRequestStart: (roundIndex: number, callId: number, info: { toolCallId?: string }) => void;
  };
} {
  let firstTokenMs: number | undefined;
  return {
    firstTokenMs: (): number | undefined => firstTokenMs,
    callbacks: {
      onFirstToken: (roundIndex: number) => {
        const ms = performance.now() - actStarted;
        if (firstTokenMs === undefined) firstTokenMs = ms;
        observer?.onFirstToken(roundIndex, ms);
      },
      onRoundStart: (roundIndex: number) => observer?.onRoundStart(roundIndex),
      onRoundEnd: (roundIndex: number) => observer?.onRoundEnd(roundIndex),
      onToolCallRequestDequeued: (roundIndex: number, callId: number) => {
        observer?.onToolCallRequestDequeued(roundIndex, callId);
      },
      onToolCallRequestEnd: (
        roundIndex: number,
        callId: number,
        info: { toolCallRequest: ToolCallRequest; isQueued: boolean },
      ) => {
        observer?.onToolCallRequestEnd(roundIndex, callId, info.toolCallRequest.name, info.isQueued);
      },
      onToolCallRequestFailure: (_roundIndex: number, callId: number, error: Error) => {
        observer?.onToolCallRequestFailure(callId, error.message);
      },
      onToolCallRequestFinalized: (_roundIndex: number, callId: number, info: { toolCallRequest: ToolCallRequest }) => {
        observer?.onToolCallRequestFinalized(callId, info.toolCallRequest.name);
      },
      onToolCallRequestNameReceived: (_roundIndex: number, callId: number, name: string) => {
        observer?.onToolCallRequestNameReceived(callId, name);
      },
      onToolCallRequestStart: (roundIndex: number, callId: number, info: { toolCallId?: string }) => {
        observer?.onToolCallRequestStart(roundIndex, callId, info.toolCallId);
      },
    },
  };
}

/**
 * Production LM Studio model-act adapter.
 *
 * This is the only production module that owns LM Studio `model.act()` policy.
 */
export class LmStudioAgentModelAct implements AgentModelActPort {
  private readonly _client: LMStudioClient;
  private readonly _model: LLM;
  private readonly _signal: AbortSignal | undefined;
  private readonly _summaryToolResultLimit: number | undefined;

  /** Creates a production LM Studio model-act adapter. */
  constructor(options: LmStudioAgentModelActOptions) {
    this._client = options.client;
    this._model = options.model;
    this._signal = options.signal;
    this._summaryToolResultLimit = options.summaryToolResultLimit;
  }

  /** Runs one normal agent turn and normalizes SDK callback output for persistence. */
  async run(request: ModelTurnRequest): Promise<ModelTurnOutput> {
    const chat = Chat.empty();
    if (request.systemPrompt) chat.replaceSystemPrompt(request.systemPrompt);
    appendMessages(this._client, chat, request.messages);

    const persistedMessages: ChatMessageData[] = [];
    const replyTexts: string[] = [];
    const actStarted = performance.now();
    const observerCallbacks = actObserverCallbacks(request.observer, actStarted);

    await this._model.act(chat, request.tools, {
      ...(getActDraftModel() ?? {}),
      ...actReasoningParsingOption(),
      allowParallelToolExecution: true,
      guardToolCall: request.guardToolCall,
      contextOverflowPolicy: "rollingWindow",
      maxTokens: 4096,
      maxPredictionRounds: getActMaxPredictionRounds(),
      onMessage: (message) => {
        request.observer?.onMessage();
        const raw = messageToData(message);
        const toPersist = chatMessageForPersistence(message);
        persistedMessages.push(messageToData(toPersist));
        if (isUserVisibleAssistantReply(raw)) {
          const text = message.getText();
          if (text) replyTexts.push(text);
        }
      },
      ...observerCallbacks.callbacks,
      signal: request.signal,
    });

    return { persistedMessages, replyTexts, firstTokenMs: observerCallbacks.firstTokenMs() };
  }

  /** Generates a structured context checkpoint summary. */
  async summarize(input: SummaryCompactionInput): Promise<string> {
    const prepared = prepareSummaryCompaction(input, this._summaryToolResultLimit);
    const chat = Chat.empty();
    if (prepared.systemPrompt) chat.replaceSystemPrompt(prepared.systemPrompt);
    chat.append("user", prepared.prompt);

    let summary = "";
    await this._model.act(chat, [], {
      ...(getActDraftModel() ?? {}),
      ...actReasoningParsingOption(),
      allowParallelToolExecution: true,
      contextOverflowPolicy: "truncateMiddle",
      maxTokens: 4096,
      maxPredictionRounds: getActMaxPredictionRounds(),
      onMessage: (message) => {
        if (message.getRole() !== "assistant") return;
        const text = message.getText();
        if (text) summary = persistedModelText(text);
      },
      signal: this._signal,
    });

    return prepared.finish(summary);
  }

  /** Extracts cron schedule intent from a user command without using tools. */
  async extractCronSchedule(request: CronScheduleExtractionRequest): Promise<RawExtractedCronSchedule> {
    const chat = Chat.empty();
    chat.replaceSystemPrompt("You extract cron scheduling intent and return strict JSON only.");
    chat.append("user", cronExtractionPrompt(request));

    let result = "";
    await this._model.act(chat, [], {
      ...(getActDraftModel() ?? {}),
      ...actReasoningParsingOption(),
      allowParallelToolExecution: true,
      contextOverflowPolicy: "truncateMiddle",
      maxTokens: 1024,
      maxPredictionRounds: 1,
      structured: { type: "json", jsonSchema: cronScheduleJsonSchema },
      onMessage: (message) => {
        if (message.getRole() !== "assistant") return;
        const text = message.getText();
        if (text) result = persistedModelText(text);
      },
      signal: request.signal ?? this._signal,
    });

    if (!result.trim()) throw new Error("Cron schedule extractor returned an empty response.");
    return parseRawExtractedCronSchedule(parseStructuredJsonResponse(result));
  }

  /** Runs a read-only subagent model act and returns the final assistant text. */
  async runSubagent(request: SubagentActRequest): Promise<SubagentActResult> {
    const chat = Chat.empty();
    if (request.systemPrompt) chat.replaceSystemPrompt(request.systemPrompt);
    chat.append("user", request.task);

    let result = "";
    const actStarted = performance.now();
    const observerCallbacks = actObserverCallbacks(request.observer, actStarted);
    await this._model.act(chat, request.tools, {
      ...(getActDraftModel() ?? {}),
      ...actReasoningParsingOption(),
      allowParallelToolExecution: true,
      contextOverflowPolicy: "truncateMiddle",
      maxTokens: 4096,
      maxPredictionRounds: getActMaxPredictionRounds(),
      onMessage: (message) => {
        request.observer?.onMessage();
        if (message.getRole() !== "assistant") return;
        const text = message.getText();
        if (text) result = persistedModelText(text);
      },
      ...observerCallbacks.callbacks,
      signal: request.signal,
    });

    return { text: result };
  }

  /** Counts tokens using LM Studio chat message materialization. */
  async countTokens(messages: ChatMessageData[]): Promise<number[]> {
    return await Promise.all(
      messages.map((message) => this._model.countTokens(materializeMessageForChat(this._client, message).toString())),
    );
  }
}
