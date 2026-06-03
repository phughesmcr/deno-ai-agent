import { Chat, ChatMessage, type ChatMessageData, type LLM, type Tool, type ToolCallRequest } from "@lmstudio/sdk";

import { logDebug } from "../../shared/log.ts";
import { traceSpan } from "../../shared/otel.ts";
import type { SummaryCompactor } from "./compactor.ts";
import type {
  SessionCompactionEntry,
  SessionEntry,
  SessionFileDetails,
  SessionMessageEntry,
  SessionStore,
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

function countTokensForMessage(model: LLM, message: ChatMessage): Promise<number> {
  return model.countTokens(message.toString());
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

/** Snapshot of session state for status commands. */
export interface SessionStatus {
  /** Current session id. */
  id: string;
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

interface SessionManagerOptions {
  store: SessionStore;
  model: LLM;
  systemPrompt: string;
  maxContextLength: number;
  reserveTokens?: number;
  keepRecentTokens?: number;
  compactor: SummaryCompactor;
}

interface RunTurnOptions {
  tools: Tool[];
  signal: AbortSignal;
  observer?: ModelActObserver;
}

/**
 * User-facing session: chat state, persistence, compaction, and model turns.
 * @internal
 */
export class SessionManager {
  readonly #store: SessionStore;
  readonly #model: LLM;
  readonly #maxContextLength: number;
  readonly #reserveTokens: number;
  readonly #keepRecentTokens: number;
  readonly #compactor: SummaryCompactor;

  #chat: Chat;
  #systemPrompt: string;
  #id: string;
  #dirty = false;
  #existsOnDisk = false;
  #tokenCount = 0;
  #entries: SessionEntry[] = [];
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(spec: SessionManagerOptions) {
    this.#store = spec.store;
    this.#model = spec.model;
    this.#systemPrompt = spec.systemPrompt;
    this.#maxContextLength = spec.maxContextLength;
    this.#reserveTokens = spec.reserveTokens ?? 16_384;
    this.#keepRecentTokens = spec.keepRecentTokens ?? 20_000;
    this.#compactor = spec.compactor;
    this.#chat = this.#freshChat();
    this.#id = crypto.randomUUID();
  }

  get id(): string {
    return this.#id;
  }

  status(): SessionStatus {
    return {
      id: this.#id,
      dirty: this.#dirty,
      existsOnDisk: this.#existsOnDisk,
      messageCount: this.#chat.getMessagesArray().length,
      tokenCount: this.#tokenCount,
      maxContextLength: this.#maxContextLength,
    };
  }

  async refreshStatus(): Promise<SessionStatus> {
    await this.#writeQueue;
    this.#rebuildChat();
    await this.#refreshTokenCount();
    return this.status();
  }

  async applySystemPrompt(prompt: string): Promise<void> {
    this.#systemPrompt = prompt;
    this.#rebuildChat();
    await this.#refreshTokenCount();
  }

  /** Starts a new in-memory session (does not write the previous one). */
  newSession(): string {
    this.#chat = this.#freshChat();
    this.#id = crypto.randomUUID();
    this.#dirty = false;
    this.#existsOnDisk = false;
    this.#tokenCount = 0;
    this.#entries = [];
    this.#writeQueue = Promise.resolve();
    return this.#id;
  }

  async save(): Promise<string> {
    await this.#writeQueue;
    if (!this.#existsOnDisk) {
      await this.#store.create(this.#id);
      await this.#store.appendMany(this.#id, this.#entries);
      this.#existsOnDisk = true;
    }
    this.#dirty = false;
    this.#rebuildChat();
    await this.#refreshTokenCount();
    return this.#id;
  }

  async load(id: string): Promise<void> {
    const log = await this.#store.read(id);
    this.#id = log.header.id;
    this.#entries = log.entries;
    this.#existsOnDisk = true;
    this.#dirty = false;
    this.#rebuildChat();
    await this.#refreshTokenCount();
  }

  /** Saves the current session, then branches into a new id with the same raw event log. */
  async fork(): Promise<{ fromId: string; toId: string }> {
    await this.save();
    const fromId = this.#id;
    const copiedEntries = structuredClone(this.#entries) as SessionEntry[];
    this.#id = crypto.randomUUID();
    this.#entries = copiedEntries;
    this.#existsOnDisk = false;
    this.#dirty = true;
    this.#rebuildChat();
    await this.#refreshTokenCount();
    return { fromId, toId: this.#id };
  }

  async list(): Promise<string[]> {
    return await this.#store.list();
  }

  /** Manually compacts the current session. */
  async compact(instructions?: string): Promise<SessionCompactionResult> {
    await this.#writeQueue;
    await this.#refreshTokenCount();
    return await this.#compact("manual", instructions);
  }

  /**
   * Appends the user message, runs `model.act`, and finalizes the context.
   * @internal
   */
  async runTurn(userText: string, options: RunTurnOptions): Promise<SessionTurnResult> {
    const { tools, signal, observer } = options;

    await this.#appendUser(userText);

    const replyTexts: string[] = [];
    const turnTokenCounts: Promise<number>[] = [];
    const persistWrites: Promise<void>[] = [];
    const actStarted = performance.now();
    let firstTokenMs: number | undefined;

    await this.#model.act(this.#snapshot(), tools, {
      onMessage: (msg) => {
        observer?.onMessage();
        const { message, persisted } = this.#appendAssistant(msg);
        persistWrites.push(persisted);
        turnTokenCounts.push(this.#model.countTokens(message.toString()));
        if (msg.getRole() === "assistant") {
          const text = msg.getText();
          if (text) replyTexts.push(text);
        }
      },
      onFirstToken: (roundIndex) => {
        const ms = performance.now() - actStarted;
        if (firstTokenMs === undefined) firstTokenMs = ms;
        observer?.onFirstToken(roundIndex, ms);
      },
      onRoundStart: (roundIndex) => observer?.onRoundStart(roundIndex),
      onRoundEnd: (roundIndex) => observer?.onRoundEnd(roundIndex),
      onToolCallRequestDequeued: (roundIndex, callId) => {
        observer?.onToolCallRequestDequeued(roundIndex, callId);
      },
      onToolCallRequestEnd: (roundIndex, callId, info) => {
        observer?.onToolCallRequestEnd(roundIndex, callId, info.toolCallRequest.name, info.isQueued);
      },
      onToolCallRequestFailure: (_roundIndex, callId, error) => {
        observer?.onToolCallRequestFailure(callId, error.message);
      },
      onToolCallRequestFinalized: (_roundIndex, callId, info) => {
        observer?.onToolCallRequestFinalized(callId, info.toolCallRequest.name);
      },
      onToolCallRequestNameReceived: (_roundIndex, callId, name) => {
        observer?.onToolCallRequestNameReceived(callId, name);
      },
      onToolCallRequestStart: (roundIndex, callId, info) => {
        observer?.onToolCallRequestStart(roundIndex, callId, info.toolCallId);
      },
      signal,
    });

    await Promise.all(persistWrites);
    const turnTokens = (await Promise.all(turnTokenCounts)).reduce((sum, n) => sum + n, 0);
    const compacted = await this.#finalizeTurn();

    return {
      replyTexts,
      firstTokenMs,
      turnTokens,
      compacted,
      totalTokens: this.#tokenCount,
    };
  }

  #freshChat(): Chat {
    const chat = Chat.empty();
    chat.replaceSystemPrompt(this.#systemPrompt);
    return chat;
  }

  #snapshot(): Chat {
    return this.#chat.asMutableCopy();
  }

  async #appendUser(text: string): Promise<ChatMessage> {
    const message = this.#append("user", text);
    await this.#persistNewEntry(createMessageEntry(messageToData(message)));
    return message;
  }

  #appendAssistant(message: ChatMessage): { message: ChatMessage; persisted: Promise<void> } {
    const appended = this.#append(message);
    return {
      message: appended,
      persisted: this.#persistNewEntry(createMessageEntry(messageToData(appended))),
    };
  }

  #append(chat: ChatMessage): ChatMessage;
  #append(role: "user" | "assistant" | "system", content: string): ChatMessage;
  #append(chatOrRole: ChatMessage | ("user" | "assistant" | "system"), content?: string): ChatMessage {
    const message = chatOrRole instanceof ChatMessage ? chatOrRole : ChatMessage.create(chatOrRole, content ?? "");
    this.#chat.append(message);
    logDebug("chat.append", {
      role: message.getRole(),
      textLength: message.getText().length,
    });
    return message;
  }

  async #persistNewEntry(entry: SessionEntry): Promise<void> {
    this.#writeQueue = this.#writeQueue.then(async () => {
      if (!this.#existsOnDisk) {
        await this.#store.create(this.#id);
        await this.#store.appendMany(this.#id, this.#entries);
        this.#existsOnDisk = true;
      }
      await this.#store.append(this.#id, entry);
      this.#entries.push(entry);
      this.#dirty = false;
    });
    await this.#writeQueue;
  }

  #rebuildChat(entries = this.#entries): void {
    this.#chat = this.#chatFromEntries(entries);
  }

  #chatFromEntries(entries: SessionEntry[]): Chat {
    const chat = this.#freshChat();
    const compaction = latestCompaction(entries);
    const firstKeptIndex = compaction?.entry.firstKeptEntryId === null || compaction === undefined ? -1 : entries
      .findIndex((entry) => entry.type === "message" && entry.id === compaction.entry.firstKeptEntryId);

    if (compaction) {
      chat.append("user", `[Earlier conversation summary]\n${compaction.entry.summary}`);
    }

    for (const [index, entry] of entries.entries()) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "system") continue;
      if (compaction) {
        const isAfterCompaction = index > compaction.index;
        const isKeptFromCheckpoint = firstKeptIndex >= 0 && index >= firstKeptIndex;
        if (!isAfterCompaction && !isKeptFromCheckpoint) continue;
      }
      chat.append(ChatMessage.from(entry.message));
    }
    return chat;
  }

  async #refreshTokenCount(): Promise<number> {
    const messages = this.#chat.getMessagesArray();
    const counts = await Promise.all(messages.map((m) => countTokensForMessage(this.#model, m)));
    this.#tokenCount = counts.reduce((sum, n) => sum + n, 0);
    return this.#tokenCount;
  }

  async #finalizeTurn(): Promise<boolean> {
    await this.#writeQueue;
    this.#rebuildChat();
    await this.#refreshTokenCount();
    if (!this.#shouldCompact()) return false;
    return (await this.#compact("auto")).compacted;
  }

  #shouldCompact(): boolean {
    return this.#tokenCount > this.#maxContextLength - this.#reserveTokens;
  }

  async #compact(reason: "auto" | "manual", instructions?: string): Promise<SessionCompactionResult> {
    return await traceSpan("context.compact", async (span) => {
      const before = this.#tokenCount;
      const previous = latestCompaction(this.#entries);
      if (reason === "manual" && this.#entries.at(-1)?.type === "compaction") {
        return { compacted: false, beforeTokens: before, afterTokens: before, reason };
      }
      const selected = await this.#selectCompactionCut(reason);
      if (!selected) return { compacted: false, beforeTokens: before, afterTokens: before, reason };

      const details = collectFileDetails(this.#entries);
      const summary = await this.#compactor({
        systemPrompt: this.#systemPrompt,
        previousSummary: previous?.entry.summary,
        messages: selected.toSummarize.map((entry) => entry.message),
        instructions,
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
        reason,
        details,
      };

      const compactedChat = this.#chatFromEntries([...this.#entries, provisional]);
      const counts = await Promise.all(
        compactedChat.getMessagesArray().map((m) => countTokensForMessage(this.#model, m)),
      );
      const after = counts.reduce((sum, n) => sum + n, 0);
      const entry: SessionCompactionEntry = { ...provisional, tokensAfter: after };

      await this.#persistNewEntry(entry);
      this.#rebuildChat();
      this.#tokenCount = after;
      span.setAttributes({
        "context.tokens.before": before,
        "context.tokens.after": after,
      });
      logDebug("context.compact", { before, after, reason });
      return { compacted: true, beforeTokens: before, afterTokens: after, reason };
    });
  }

  #visibleMessageEntries(entries: SessionEntry[]): Omit<MessageEntryWithIndex, "tokens">[] {
    const compaction = latestCompaction(entries);
    const firstKeptIndex = compaction?.entry.firstKeptEntryId === null || compaction === undefined ? -1 : entries
      .findIndex((entry) => entry.type === "message" && entry.id === compaction.entry.firstKeptEntryId);

    return entries
      .map((entry, index) => entry.type === "message" ? { entry, index } : undefined)
      .filter((entry): entry is Omit<MessageEntryWithIndex, "tokens"> => {
        if (entry === undefined || entry.entry.message.role === "system") return false;
        if (!compaction) return true;
        return entry.index > compaction.index || (firstKeptIndex >= 0 && entry.index >= firstKeptIndex);
      });
  }

  async #selectCompactionCut(reason: "auto" | "manual"): Promise<
    { firstKeptEntryId: string | null; toSummarize: SessionMessageEntry[] } | undefined
  > {
    const messageEntries = this.#visibleMessageEntries(this.#entries);
    if (messageEntries.length === 0) return undefined;
    if (reason === "manual") {
      return {
        firstKeptEntryId: null,
        toSummarize: messageEntries.map(({ entry }) => entry),
      };
    }
    if (messageEntries.length < 2) return undefined;

    const tokenCounts = await Promise.all(
      messageEntries.map(({ entry }) => countTokensForMessage(this.#model, ChatMessage.from(entry.message))),
    );
    const withTokens = messageEntries.map((entry, index) => ({ ...entry, tokens: tokenCounts[index] ?? 0 }));

    let retainedTokens = 0;
    let firstKeptMessageIndex = withTokens.length;
    for (let index = withTokens.length - 1; index >= 0; index -= 1) {
      const candidate = withTokens[index];
      if (!candidate) continue;
      if (firstKeptMessageIndex !== withTokens.length && retainedTokens + candidate.tokens > this.#keepRecentTokens) {
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
}
