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
import {
  type CronScheduleExtractionRequest,
  type CronScheduleExtractor,
  parseRawExtractedCronSchedule,
  type RawExtractedCronSchedule,
} from "../cron/schedule.ts";
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

function appendMessages(client: LMStudioClient, chat: Chat, messages: ChatMessageData[]): void {
  for (const message of messages) {
    chat.append(materializeMessageForChat(client, message));
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  const jsonText = fenced?.[1]?.trim() ?? firstBalancedJsonObject(trimmed);
  return JSON.parse(jsonText) as unknown;
}

function firstBalancedJsonObject(text: string): string {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    const candidate = balancedJsonObjectFrom(text, start);
    if (candidate) return candidate;
  }
  throw new Error("Cron schedule extractor response did not contain a JSON object.");
}

function balancedJsonObjectFrom(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (char === undefined) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return undefined;
}

const cronScheduleJsonSchema = {
  type: "object",
  oneOf: [
    {
      required: ["status", "prompt", "scheduleText", "schedule"],
      properties: {
        status: { const: "ok" },
        prompt: { type: "string", minLength: 1 },
        scheduleText: { type: "string", minLength: 1 },
        schedule: {
          type: "object",
          oneOf: [
            {
              required: ["kind", "recurrence"],
              properties: {
                kind: { const: "recurring" },
                timezone: { type: "string", minLength: 1 },
                recurrence: {
                  type: "object",
                  oneOf: [
                    {
                      required: ["kind", "every", "unit"],
                      properties: {
                        kind: { const: "interval" },
                        every: { type: "integer", minimum: 1 },
                        unit: { enum: ["minute", "hour"] },
                      },
                    },
                    {
                      required: ["kind", "hour", "minute"],
                      properties: {
                        kind: { const: "daily" },
                        hour: { type: "integer", minimum: 0, maximum: 23 },
                        minute: { type: "integer", minimum: 0, maximum: 59 },
                      },
                    },
                    {
                      required: ["kind", "weekday", "hour", "minute"],
                      properties: {
                        kind: { const: "weekly" },
                        weekday: {
                          enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
                        },
                        hour: { type: "integer", minimum: 0, maximum: 23 },
                        minute: { type: "integer", minimum: 0, maximum: 59 },
                      },
                    },
                    {
                      required: ["kind", "hour", "minute"],
                      properties: {
                        kind: { const: "weekdays" },
                        hour: { type: "integer", minimum: 0, maximum: 23 },
                        minute: { type: "integer", minimum: 0, maximum: 59 },
                      },
                    },
                  ],
                },
              },
            },
            {
              required: ["kind", "date", "time"],
              properties: {
                kind: { const: "once" },
                timezone: { type: "string", minLength: 1 },
                date: {
                  type: "object",
                  oneOf: [
                    {
                      required: ["kind", "date"],
                      properties: {
                        kind: { const: "date" },
                        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                      },
                    },
                    {
                      required: ["kind", "weekday"],
                      properties: {
                        kind: { const: "next_weekday" },
                        weekday: {
                          enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
                        },
                      },
                    },
                  ],
                },
                time: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
              },
            },
          ],
        },
      },
    },
    {
      required: ["status", "question"],
      properties: {
        status: { const: "needs_clarification" },
        prompt: { type: "string", minLength: 1 },
        scheduleText: { type: "string", minLength: 1 },
        question: { type: "string", minLength: 1 },
      },
    },
    {
      required: ["status", "message"],
      properties: {
        status: { const: "unsupported" },
        message: { type: "string", minLength: 1 },
      },
    },
  ],
} as const;

function cronExtractionPrompt(request: CronScheduleExtractionRequest): string {
  return [
    "Extract schedule intent for a Silas /cron new command.",
    "Return JSON only. Do not include Markdown.",
    "",
    "Output shape:",
    '{"status":"ok","prompt":"...","scheduleText":"...","schedule":{"kind":"recurring","timezone":"Europe/London","recurrence":{"kind":"interval","every":1,"unit":"minute"}}}',
    '{"status":"ok","prompt":"...","scheduleText":"...","schedule":{"kind":"once","timezone":"Europe/London","date":{"kind":"next_weekday","weekday":"tuesday"},"time":"10:00"}}',
    '{"status":"needs_clarification","prompt":"...","scheduleText":"...","question":"What time should I remind you?"}',
    '{"status":"unsupported","message":"..."}',
    "",
    "Rules:",
    "- Split the command into scheduleText and prompt.",
    "- For recurring schedules, use interval, daily, weekly, or weekdays recurrence.",
    "- For one-shot schedules, include date and 24-hour HH:mm time.",
    "- If a one-shot schedule has no explicit time and no clarification supplies one, return needs_clarification.",
    "- Use the default timezone unless the user explicitly names another timezone.",
    "- Do not compute exact instants or nextRunAt.",
    "",
    `Now: ${request.now.toISOString()}`,
    `Default timezone: ${request.defaultTimezone}`,
    `Command: ${request.input}`,
    request.clarification ? `Clarification answer: ${request.clarification}` : "",
  ].filter((line) => line.length > 0).join("\n");
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
    return parseRawExtractedCronSchedule(extractJsonObject(result));
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
