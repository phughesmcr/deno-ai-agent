import {
  Chat,
  ChatMessage,
  type ChatMessageData,
  type LLM,
  type LMStudioClient,
  type Tool,
  type ToolCallRequest,
} from "@lmstudio/sdk";

import { getActMaxPredictionRounds } from "../../shared/act-config.ts";
import { getActDraftModel } from "../../shared/draft-model.ts";
import { logDebug } from "../../shared/log.ts";
import { traceSpan } from "../../shared/otel.ts";
import { actReasoningParsingOption } from "../../shared/reasoning.ts";
import type { ToolCallGuard } from "../tools/authorization.ts";
import { normalizeUserTurnInput, type UserTurnInput } from "../user-turn.ts";
import type { SummaryCompactionInput } from "./compactor.ts";
import { materializeMessageForChat } from "./message-materialize.ts";
import { chatMessageForPersistence } from "./persisted-message.ts";
import {
  isValidSessionName,
  type SessionCompactionEntry,
  type SessionEntry,
  type SessionFileDetails,
  type SessionMessageEntry,
  type SessionStore,
} from "./session-store.ts";

/** @internal SDK exposes getRaw() at runtime but not in public types. */
type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

interface MessageEntryWithIndex {
  entry: SessionMessageEntry;
  index: number;
  tokens: number;
}

function messageToData(message: ChatMessage): ChatMessageData {
  return (message as ChatMessageWithRaw).getRaw();
}

function createTextMessageData(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return messageToData(ChatMessage.create(role, text));
}

function createMessageEntry(message: ChatMessageData): SessionMessageEntry {
  return {
    type: "message",
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    message,
  };
}

function emptyDetails(): SessionFileDetails {
  return { readFiles: [], modifiedFiles: [] };
}

function addUnique(target: string[], value: unknown): void {
  if (typeof value !== "string" || value.length === 0 || target.includes(value)) return;
  target.push(value);
}

function toolRequests(message: ChatMessageData): ToolCallRequest[] {
  return message.content.flatMap((part) => part.type === "toolCallRequest" ? [part.toolCallRequest] : []);
}

function isUserVisibleAssistantReply(message: ChatMessageData): boolean {
  return message.role === "assistant" && toolRequests(message).length === 0;
}

function collectFileDetails(entries: SessionEntry[]): SessionFileDetails {
  const details = emptyDetails();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      for (const file of entry.details.readFiles) addUnique(details.readFiles, file);
      for (const file of entry.details.modifiedFiles) addUnique(details.modifiedFiles, file);
      continue;
    }
    if (entry.message.role !== "assistant") continue;
    for (const request of toolRequests(entry.message)) {
      if (request.name === "read") addUnique(details.readFiles, request.arguments?.["path"]);
      if (request.name === "write" || request.name === "edit") {
        addUnique(details.modifiedFiles, request.arguments?.["path"]);
      }
    }
  }
  return details;
}

function latestCompaction(entries: SessionEntry[]): { entry: SessionCompactionEntry; index: number } | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "compaction") return { entry, index };
  }
  return undefined;
}

function isSafeFirstKept(message: ChatMessageData): boolean {
  if (message.role === "user") return true;
  if (message.role !== "assistant") return false;
  return toolRequests(message).length === 0;
}

function statusFromLedger(
  ledger: SessionLedger,
  messageCount: number,
  tokenCount: number,
  maxContextLength: number,
): SessionStatus {
  return {
    id: ledger.id,
    name: ledger.name,
    dirty: ledger.dirty,
    existsOnDisk: ledger.existsOnDisk,
    messageCount,
    tokenCount,
    maxContextLength,
  };
}

/** Summary of a saved session for list commands. */
export interface SavedSessionSummary {
  /** Session identifier. */
  id: string;
  /** ISO timestamp when the session log was created. */
  createdAt: string;
  /** User-facing alias when set. */
  name?: string;
}

/** Snapshot of session state for status commands. */
export interface SessionStatus {
  /** Current session id. */
  id: string;
  /** User-facing alias when set. */
  name?: string;
  /** Whether unsaved changes exist in memory. */
  dirty: boolean;
  /** Whether the current id exists on disk. */
  existsOnDisk: boolean;
  /** Number of messages in context. */
  messageCount: number;
  /** Estimated token count for the context. */
  tokenCount: number;
  /** Model context window size. */
  maxContextLength: number;
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

/** Result of a single user turn through the model. */
export interface SessionTurnResult {
  /** Assistant reply texts from this turn. */
  replyTexts: string[];
  /** Time to first model token, when one was observed. */
  firstTokenMs?: number;
  /** Tokens used by assistant messages this turn. */
  turnTokens: number;
  /** Whether context was compacted after this turn. */
  compacted: boolean;
  /** Total context token count after finalization. */
  totalTokens: number;
}

/** Telemetry hooks for the LM Studio `model.act()` lifecycle. */
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
 * Request passed from session orchestration to a model adapter.
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

/**
 * Adapter boundary for generating compaction summaries.
 * @internal
 */
export interface ContextSummaryPort {
  /** Generates an updated structured context checkpoint. */
  summarize(input: SummaryCompactionInput): Promise<string>;
}

/**
 * Options for one session turn.
 * @internal
 */
export interface SessionTurnOptions {
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
 * Caller-facing session API.
 * @internal
 */
export interface AgentSessions {
  /** Current in-memory session identity. */
  readonly current: { id: string; name?: string };

  /** Runs one user turn and persists resulting session events. */
  turn(input: string | UserTurnInput, options: SessionTurnOptions): Promise<SessionTurnResult>;

  /** Starts a fresh in-memory session without saving the previous one. */
  readonly new: () => SessionStatus;
  /** Saves the current session log to disk. */
  save(): Promise<SessionStatus>;
  /** Loads a saved session by id or name. */
  load(ref: string): Promise<SessionStatus>;
  /** Saves the current session and branches into a new unsaved session id. */
  fork(): Promise<{ from: SessionStatus; to: SessionStatus }>;
  /** Sets a user-facing session name. */
  rename(name: string): Promise<SessionStatus>;
  /** Lists saved sessions. */
  list(): Promise<SavedSessionSummary[]>;
  /** Returns the current status, optionally refreshing token counts. */
  status(options?: { refresh?: boolean }): Promise<SessionStatus>;
  /** Appends a manual compaction checkpoint when possible. */
  compact(options?: { instructions?: string }): Promise<SessionCompactionResult>;
  /** Applies the latest system prompt to future context projections. */
  applySystemPrompt(prompt: string): Promise<SessionStatus>;
}

interface PersistentAgentSessionsOptions {
  store: SessionStore;
  model: ModelTurnPort;
  summary: ContextSummaryPort;
  systemPrompt: string;
  maxContextLength: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

interface LmStudioModelTurnPortOptions {
  client: LMStudioClient;
  model: LLM;
}

const DEFAULT_RESERVE_TOKEN_RATIO = 0.25;
const DEFAULT_KEEP_RECENT_TOKEN_RATIO = 0.5;

function percentageTokens(maxContextLength: number, ratio: number): number {
  if (!Number.isFinite(maxContextLength) || maxContextLength <= 0) return 1;
  return Math.max(1, Math.floor(maxContextLength * ratio));
}

class SessionLedger {
  private readonly _store: SessionStore;
  private _id: string = crypto.randomUUID();
  private _name: string | undefined;
  private _dirty = false;
  private _existsOnDisk = false;
  private _entries: SessionEntry[] = [];
  private _writeQueue: Promise<void> = Promise.resolve();

  constructor(store: SessionStore) {
    this._store = store;
  }

  get id(): string {
    return this._id;
  }

  get name(): string | undefined {
    return this._name;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  get existsOnDisk(): boolean {
    return this._existsOnDisk;
  }

  get entries(): readonly SessionEntry[] {
    return this._entries;
  }

  get current(): { id: string; name?: string } {
    return this._name ? { id: this._id, name: this._name } : { id: this._id };
  }

  new(): void {
    this._id = crypto.randomUUID();
    this._name = undefined;
    this._dirty = false;
    this._existsOnDisk = false;
    this._entries = [];
    this._writeQueue = Promise.resolve();
  }

  async save(): Promise<void> {
    await this._writeQueue;
    if (!this._existsOnDisk) {
      await this._store.create(this._id, { name: this._name });
      await this._store.appendMany(this._id, this._entries);
      this._existsOnDisk = true;
    }
    this._dirty = false;
  }

  async load(ref: string): Promise<void> {
    await this._writeQueue;
    const id = await this._store.resolveId(ref);
    const log = await this._store.read(id);
    this._id = log.header.id;
    this._name = log.header.name;
    this._entries = log.entries;
    this._existsOnDisk = true;
    this._dirty = false;
    this._writeQueue = Promise.resolve();
  }

  async fork(): Promise<void> {
    await this.save();
    this._id = crypto.randomUUID();
    this._name = undefined;
    this._entries = structuredClone(this._entries) as SessionEntry[];
    this._existsOnDisk = false;
    this._dirty = true;
    this._writeQueue = Promise.resolve();
  }

  async rename(name: string): Promise<void> {
    if (!isValidSessionName(name)) throw new Error("Invalid session name");
    const matches = await this._store.findIdsByName(name, this._id);
    if (matches.length > 0) throw new Error("Session name already in use");
    await this._writeQueue;
    this._name = name;
    if (this._existsOnDisk) await this._store.setName(this._id, name);
  }

  async list(): Promise<SavedSessionSummary[]> {
    return (await this._store.listHeaders()).map((header) => ({
      id: header.id,
      createdAt: header.createdAt,
      name: header.name,
    }));
  }

  async appendEntries(entries: SessionEntry[]): Promise<void> {
    if (entries.length === 0) return;
    this._writeQueue = this._writeQueue.then(async () => {
      if (!this._existsOnDisk) {
        await this._store.create(this._id, { name: this._name });
        await this._store.appendMany(this._id, this._entries);
        this._existsOnDisk = true;
      }
      await this._store.appendMany(this._id, entries);
      this._entries.push(...entries);
      this._dirty = false;
    });
    await this._writeQueue;
  }

  async awaitWrites(): Promise<void> {
    await this._writeQueue;
  }
}

class ContextProjector {
  project(entries: readonly SessionEntry[]): ChatMessageData[] {
    const messages: ChatMessageData[] = [];
    const compaction = latestCompaction([...entries]);
    const firstKeptIndex = this._firstKeptIndex(entries, compaction);

    if (compaction) {
      messages.push(createTextMessageData("user", `[Earlier conversation summary]\n${compaction.entry.summary}`));
    }

    for (const [index, entry] of entries.entries()) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "system") continue;
      if (compaction) {
        const isAfterCompaction = index > compaction.index;
        const isKeptFromCheckpoint = firstKeptIndex >= 0 && index >= firstKeptIndex;
        if (!isAfterCompaction && !isKeptFromCheckpoint) continue;
      }
      messages.push(entry.message);
    }

    return messages;
  }

  visibleMessageEntries(entries: readonly SessionEntry[]): Omit<MessageEntryWithIndex, "tokens">[] {
    const compaction = latestCompaction([...entries]);
    const firstKeptIndex = this._firstKeptIndex(entries, compaction);

    return entries
      .map((entry, index) => entry.type === "message" ? { entry, index } : undefined)
      .filter((entry): entry is Omit<MessageEntryWithIndex, "tokens"> => {
        if (entry === undefined || entry.entry.message.role === "system") return false;
        if (!compaction) return true;
        return entry.index > compaction.index || (firstKeptIndex >= 0 && entry.index >= firstKeptIndex);
      });
  }

  _firstKeptIndex(
    entries: readonly SessionEntry[],
    compaction: { entry: SessionCompactionEntry; index: number } | undefined,
  ): number {
    if (compaction === undefined || compaction.entry.firstKeptEntryId === null) return -1;
    return entries.findIndex((entry) => entry.type === "message" && entry.id === compaction.entry.firstKeptEntryId);
  }
}

class CompactionController {
  private readonly _model: ModelTurnPort;
  private readonly _summary: ContextSummaryPort;
  private readonly _projector: ContextProjector;
  private readonly _maxContextLength: number;
  private readonly _reserveTokens: number;
  private readonly _keepRecentTokens: number;

  constructor(options: {
    model: ModelTurnPort;
    summary: ContextSummaryPort;
    projector: ContextProjector;
    maxContextLength: number;
    reserveTokens?: number;
    keepRecentTokens?: number;
  }) {
    this._model = options.model;
    this._summary = options.summary;
    this._projector = options.projector;
    this._maxContextLength = options.maxContextLength;
    this._reserveTokens = options.reserveTokens ??
      percentageTokens(options.maxContextLength, DEFAULT_RESERVE_TOKEN_RATIO);
    this._keepRecentTokens = options.keepRecentTokens ??
      percentageTokens(options.maxContextLength, DEFAULT_KEEP_RECENT_TOKEN_RATIO);
  }

  shouldCompact(tokenCount: number): boolean {
    return tokenCount > this._maxContextLength - this._reserveTokens;
  }

  async compact(options: {
    entries: readonly SessionEntry[];
    systemPrompt: string;
    beforeTokens: number;
    reason: "auto" | "manual";
    instructions?: string;
    append: (entry: SessionCompactionEntry) => Promise<void>;
  }): Promise<SessionCompactionResult> {
    return await traceSpan("context.compact", async (span) => {
      const before = options.beforeTokens;
      const entries = [...options.entries];
      const previous = latestCompaction(entries);
      if (options.reason === "manual" && entries.at(-1)?.type === "compaction") {
        return { compacted: false, beforeTokens: before, afterTokens: before, reason: options.reason };
      }

      const selected = await this._selectCompactionCut(entries, options.reason);
      if (!selected) {
        return { compacted: false, beforeTokens: before, afterTokens: before, reason: options.reason };
      }

      const details = collectFileDetails(entries);
      const summary = await this._summary.summarize({
        systemPrompt: options.systemPrompt,
        previousSummary: previous?.entry.summary,
        messages: selected.toSummarize.map((entry) => entry.message),
        instructions: options.instructions,
        details,
      });

      const provisional: SessionCompactionEntry = {
        type: "compaction",
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        summary,
        firstKeptEntryId: selected.firstKeptEntryId,
        tokensBefore: before,
        tokensAfter: before,
        reason: options.reason,
        details,
      };
      const after = await this._countContextTokens(options.systemPrompt, [...entries, provisional]);
      const entry: SessionCompactionEntry = { ...provisional, tokensAfter: after };

      await options.append(entry);
      span.setAttributes({
        "context.tokens.before": before,
        "context.tokens.after": after,
      });
      logDebug("context.compact", { before, after, reason: options.reason });
      return { compacted: true, beforeTokens: before, afterTokens: after, reason: options.reason };
    });
  }

  async _selectCompactionCut(
    entries: readonly SessionEntry[],
    reason: "auto" | "manual",
  ): Promise<{ firstKeptEntryId: string | null; toSummarize: SessionMessageEntry[] } | undefined> {
    const messageEntries = this._projector.visibleMessageEntries(entries);
    if (messageEntries.length === 0) return undefined;
    if (reason === "manual") {
      return {
        firstKeptEntryId: null,
        toSummarize: messageEntries.map(({ entry }) => entry),
      };
    }
    if (messageEntries.length < 2) return undefined;

    const tokenCounts = await this._model.countTokens(messageEntries.map(({ entry }) => entry.message));
    const withTokens = messageEntries.map((entry, index) => ({ ...entry, tokens: tokenCounts[index] ?? 0 }));

    let retainedTokens = 0;
    let firstKeptMessageIndex = withTokens.length;
    for (let index = withTokens.length - 1; index >= 0; index -= 1) {
      const candidate = withTokens[index];
      if (!candidate) continue;
      if (firstKeptMessageIndex !== withTokens.length && retainedTokens + candidate.tokens > this._keepRecentTokens) {
        break;
      }
      retainedTokens += candidate.tokens;
      firstKeptMessageIndex = index;
    }

    while (firstKeptMessageIndex > 0 && !isSafeFirstKept(withTokens[firstKeptMessageIndex]!.entry.message)) {
      firstKeptMessageIndex -= 1;
    }

    if (firstKeptMessageIndex <= 0) return undefined;

    const firstKept = withTokens[firstKeptMessageIndex]!;
    const toSummarize = withTokens
      .filter(({ index }) => index < firstKept.index)
      .map(({ entry }) => entry);

    if (toSummarize.length === 0) return undefined;
    return { firstKeptEntryId: firstKept.entry.id, toSummarize };
  }

  async _countContextTokens(systemPrompt: string, entries: readonly SessionEntry[]): Promise<number> {
    const messages = [createTextMessageData("system", systemPrompt), ...this._projector.project(entries)];
    const counts = await this._model.countTokens(messages);
    return counts.reduce((sum, count) => sum + count, 0);
  }
}

/**
 * User-facing session facade: chat state, persistence, projection, compaction, and model turns.
 * @internal
 */
export class PersistentAgentSessions implements AgentSessions {
  private readonly _ledger: SessionLedger;
  private readonly _projector = new ContextProjector();
  private readonly _model: ModelTurnPort;
  private readonly _compaction: CompactionController;
  private readonly _maxContextLength: number;
  private _systemPrompt: string;
  private _tokenCount = 0;

  constructor(spec: PersistentAgentSessionsOptions) {
    this._ledger = new SessionLedger(spec.store);
    this._model = spec.model;
    this._systemPrompt = spec.systemPrompt;
    this._maxContextLength = spec.maxContextLength;
    this._compaction = new CompactionController({
      model: spec.model,
      summary: spec.summary,
      projector: this._projector,
      maxContextLength: spec.maxContextLength,
      reserveTokens: spec.reserveTokens,
      keepRecentTokens: spec.keepRecentTokens,
    });
  }

  get current(): { id: string; name?: string } {
    return this._ledger.current;
  }

  async turn(input: string | UserTurnInput, options: SessionTurnOptions): Promise<SessionTurnResult> {
    const userInput = normalizeUserTurnInput(input);
    const userMessage = this._createUserMessage(userInput);
    await this._appendEntries([createMessageEntry(userMessage)]);

    const output = await this._model.run({
      systemPrompt: this._systemPrompt,
      messages: this._projector.project(this._ledger.entries),
      tools: options.tools,
      guardToolCall: options.guardToolCall,
      signal: options.signal,
      observer: options.observer,
    });

    const assistantEntries = output.persistedMessages.map(createMessageEntry);
    for (const message of output.persistedMessages) this._logAppend(message);
    await this._appendEntries(assistantEntries);

    const turnTokens = (await this._model.countTokens(output.persistedMessages))
      .reduce((sum, count) => sum + count, 0);
    const compacted = await this._finalizeTurn();

    return {
      replyTexts: output.replyTexts,
      firstTokenMs: output.firstTokenMs,
      turnTokens,
      compacted,
      totalTokens: this._tokenCount,
    };
  }

  new(): SessionStatus {
    this._ledger.new();
    this._tokenCount = 0;
    return this._status();
  }

  async save(): Promise<SessionStatus> {
    await this._ledger.save();
    return await this.status({ refresh: true });
  }

  async load(ref: string): Promise<SessionStatus> {
    await this._ledger.load(ref);
    return await this.status({ refresh: true });
  }

  async fork(): Promise<{ from: SessionStatus; to: SessionStatus }> {
    const fromStatus = await this.save();
    await this._ledger.fork();
    const to = await this.status({ refresh: true });
    return { from: fromStatus, to };
  }

  async rename(name: string): Promise<SessionStatus> {
    await this._ledger.rename(name);
    return this._status();
  }

  async list(): Promise<SavedSessionSummary[]> {
    return await this._ledger.list();
  }

  async status(options?: { refresh?: boolean }): Promise<SessionStatus> {
    await this._ledger.awaitWrites();
    if (options?.refresh) await this._refreshTokenCount();
    return this._status();
  }

  async compact(options?: { instructions?: string }): Promise<SessionCompactionResult> {
    await this._ledger.awaitWrites();
    await this._refreshTokenCount();
    const result = await this._compaction.compact({
      entries: this._ledger.entries,
      systemPrompt: this._systemPrompt,
      beforeTokens: this._tokenCount,
      reason: "manual",
      instructions: options?.instructions,
      append: (entry) => this._appendEntries([entry]),
    });
    this._tokenCount = result.afterTokens;
    return result;
  }

  async applySystemPrompt(prompt: string): Promise<SessionStatus> {
    this._systemPrompt = prompt;
    await this._refreshTokenCount();
    return this._status();
  }

  _createUserMessage(input: UserTurnInput): ChatMessageData {
    const message = ChatMessage.create("user", input.text);
    for (const image of input.images ?? []) message.appendFile(image);
    this._logAppend(messageToData(message), input.images?.length ?? 0);
    return messageToData(message);
  }

  async _appendEntries(entries: SessionEntry[]): Promise<void> {
    await this._ledger.appendEntries(entries);
  }

  async _finalizeTurn(): Promise<boolean> {
    await this._ledger.awaitWrites();
    await this._refreshTokenCount();
    if (!this._compaction.shouldCompact(this._tokenCount)) return false;
    const result = await this._compaction.compact({
      entries: this._ledger.entries,
      systemPrompt: this._systemPrompt,
      beforeTokens: this._tokenCount,
      reason: "auto",
      append: (entry) => this._appendEntries([entry]),
    });
    this._tokenCount = result.afterTokens;
    return result.compacted;
  }

  async _refreshTokenCount(): Promise<number> {
    const messages = [
      createTextMessageData("system", this._systemPrompt),
      ...this._projector.project(this._ledger.entries),
    ];
    const counts = await this._model.countTokens(messages);
    this._tokenCount = counts.reduce((sum, count) => sum + count, 0);
    return this._tokenCount;
  }

  _status(): SessionStatus {
    const messageCount = 1 + this._projector.project(this._ledger.entries).length;
    return statusFromLedger(this._ledger, messageCount, this._tokenCount, this._maxContextLength);
  }

  _logAppend(message: ChatMessageData, imageCount = 0): void {
    const textLength = message.content
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("")
      .length;
    logDebug("chat.append", {
      role: message.role,
      textLength,
      ...(imageCount > 0 ? { imageCount } : {}),
    });
  }
}

/**
 * Production LM Studio model adapter for session turns.
 * @internal
 */
export class LmStudioModelTurnPort implements ModelTurnPort {
  private readonly _client: LMStudioClient;
  private readonly _model: LLM;

  /** Creates a production LM Studio model turn adapter. */
  constructor(options: LmStudioModelTurnPortOptions) {
    this._client = options.client;
    this._model = options.model;
  }

  /** Runs `model.act()` and normalizes SDK callback output for persistence. */
  async run(request: ModelTurnRequest): Promise<ModelTurnOutput> {
    const chat = Chat.empty();
    if (request.systemPrompt) chat.replaceSystemPrompt(request.systemPrompt);
    for (const message of request.messages) {
      chat.append(materializeMessageForChat(this._client, message));
    }

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

  /** Counts tokens using LM Studio chat message materialization. */
  async countTokens(messages: ChatMessageData[]): Promise<number[]> {
    return await Promise.all(
      messages.map((message) => this._model.countTokens(materializeMessageForChat(this._client, message).toString())),
    );
  }
}
