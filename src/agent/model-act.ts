import {
  Chat,
  type ChatMessage,
  type ChatMessageData,
  type LLM,
  type LMStudioClient,
  type Tool,
  type ToolCallRequest,
} from "@lmstudio/sdk";

import { getActMaxPredictionRounds } from "../shared/act-config.ts";
import { getActDraftModel } from "../shared/draft-model.ts";
import { actReasoningParsingOption, persistedModelText } from "../shared/reasoning.ts";
import { prepareSummaryCompaction, type SummaryCompactionInput } from "./context/compactor.ts";
import { materializeMessageForChat } from "./context/message-materialize.ts";
import { chatMessageForPersistence } from "./context/persisted-message.ts";
import type { ContextSummaryPort, ModelTurnOutput, ModelTurnPort, ModelTurnRequest } from "./context/session.ts";

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
}

/** Result of a read-only subagent model act. */
export interface SubagentActResult {
  /** Final assistant text with persistence reasoning policy applied. */
  text: string;
}

/** Unified model-act boundary for normal turns, compaction summaries, and subagents. */
export interface AgentModelActPort extends ModelTurnPort, ContextSummaryPort {
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

function appendMessages(client: LMStudioClient, chat: Chat, messages: ChatMessageData[]): void {
  for (const message of messages) {
    chat.append(materializeMessageForChat(client, message));
  }
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
    let firstTokenMs: number | undefined;

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
      onFirstToken: (roundIndex) => {
        const ms = performance.now() - actStarted;
        if (firstTokenMs === undefined) firstTokenMs = ms;
        request.observer?.onFirstToken(roundIndex, ms);
      },
      onRoundStart: (roundIndex) => request.observer?.onRoundStart(roundIndex),
      onRoundEnd: (roundIndex) => request.observer?.onRoundEnd(roundIndex),
      onToolCallRequestDequeued: (roundIndex, callId) => {
        request.observer?.onToolCallRequestDequeued(roundIndex, callId);
      },
      onToolCallRequestEnd: (roundIndex, callId, info) => {
        request.observer?.onToolCallRequestEnd(roundIndex, callId, info.toolCallRequest.name, info.isQueued);
      },
      onToolCallRequestFailure: (_roundIndex, callId, error) => {
        request.observer?.onToolCallRequestFailure(callId, error.message);
      },
      onToolCallRequestFinalized: (_roundIndex, callId, info) => {
        request.observer?.onToolCallRequestFinalized(callId, info.toolCallRequest.name);
      },
      onToolCallRequestNameReceived: (_roundIndex, callId, name) => {
        request.observer?.onToolCallRequestNameReceived(callId, name);
      },
      onToolCallRequestStart: (roundIndex, callId, info) => {
        request.observer?.onToolCallRequestStart(roundIndex, callId, info.toolCallId);
      },
      signal: request.signal,
    });

    return { persistedMessages, replyTexts, firstTokenMs };
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

  /** Runs a read-only subagent model act and returns the final assistant text. */
  async runSubagent(request: SubagentActRequest): Promise<SubagentActResult> {
    const chat = Chat.empty();
    if (request.systemPrompt) chat.replaceSystemPrompt(request.systemPrompt);
    chat.append("user", request.task);

    let result = "";
    await this._model.act(chat, request.tools, {
      ...(getActDraftModel() ?? {}),
      ...actReasoningParsingOption(),
      allowParallelToolExecution: true,
      contextOverflowPolicy: "truncateMiddle",
      maxTokens: 4096,
      maxPredictionRounds: getActMaxPredictionRounds(),
      onMessage: (message) => {
        if (message.getRole() !== "assistant") return;
        const text = message.getText();
        if (text) result = persistedModelText(text);
      },
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
