import { Chat, ChatMessage, type ChatMessageData, type LLM, type Tool } from "@lmstudio/sdk";

import { logDebug } from "../../shared/log.ts";
import { traceSpan } from "../../shared/otel.ts";
import type { SessionStore } from "./session-store.ts";

/** @internal SDK exposes getRaw() at runtime but not in public types. */
type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

function messageToData(message: ChatMessage): ChatMessageData {
  return (message as ChatMessageWithRaw).getRaw();
}

function countTokensForMessage(model: LLM, message: ChatMessage): Promise<number> {
  return model.countTokens(message.toString());
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

/** Result of a single user turn through the model. */
export interface SessionTurnResult {
  /** Assistant reply texts from this turn. */
  replyTexts: string[];
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
  /** Ends a tool call span after the request is finalized. */
  onToolCallRequestFinalized(callId: number, name: string): void;
  /** Records that a queued tool call started executing. */
  onToolCallRequestDequeued(roundIndex: number, callId: number): void;
}

interface SessionManagerOptions {
  store: SessionStore;
  model: LLM;
  systemPrompt: string;
  maxContextLength: number;
  compactPercentage?: number;
  compactor: (chat: Chat) => Promise<Chat>;
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
  readonly #compactPercentage: number;
  readonly #compactor: (chat: Chat) => Promise<Chat>;

  #chat: Chat;
  #systemPrompt: string;
  #id: string;
  #dirty = false;
  #existsOnDisk = false;
  #tokenCount = 0;

  constructor(spec: SessionManagerOptions) {
    this.#store = spec.store;
    this.#model = spec.model;
    this.#systemPrompt = spec.systemPrompt;
    this.#maxContextLength = spec.maxContextLength;
    this.#compactPercentage = spec.compactPercentage ?? 0.75;
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
    await this.#refreshTokenCount();
    return this.status();
  }

  async applySystemPrompt(prompt: string): Promise<void> {
    this.#systemPrompt = prompt;
    this.#chat.replaceSystemPrompt(prompt);
    await this.#refreshTokenCount();
  }

  /** Starts a new in-memory session (does not write the previous one). */
  newSession(): string {
    this.#chat = this.#freshChat();
    this.#id = crypto.randomUUID();
    this.#dirty = false;
    this.#existsOnDisk = false;
    this.#tokenCount = 0;
    return this.#id;
  }

  async save(): Promise<string> {
    await this.#store.save(this.#id, this.#exportMessages());
    this.#dirty = false;
    this.#existsOnDisk = true;
    return this.#id;
  }

  async load(id: string): Promise<void> {
    if (!(await this.#store.exists(id))) {
      throw new Error(`Session not found: ${id}`);
    }
    const messages = await this.#store.load(id);
    this.#chat = Chat.from({ messages });
    this.#chat.replaceSystemPrompt(this.#systemPrompt);
    await this.#refreshTokenCount();
    this.#id = id;
    this.#dirty = false;
    this.#existsOnDisk = true;
  }

  /** Saves the current session, then branches into a new id with the same history. */
  async fork(): Promise<{ fromId: string; toId: string }> {
    const fromId = this.#id;
    if (this.#dirty || !this.#existsOnDisk) {
      await this.save();
    }
    const messages = this.#exportMessages();
    this.#id = crypto.randomUUID();
    this.#chat = Chat.from({ messages });
    this.#chat.replaceSystemPrompt(this.#systemPrompt);
    await this.#refreshTokenCount();
    this.#dirty = true;
    this.#existsOnDisk = false;
    return { fromId, toId: this.#id };
  }

  async list(): Promise<string[]> {
    return await this.#store.list();
  }

  /**
   * Appends the user message, runs `model.act`, and finalizes the context.
   * @internal
   */
  async runTurn(userText: string, options: RunTurnOptions): Promise<SessionTurnResult> {
    const { tools, signal, observer } = options;

    this.#appendUser(userText);

    const replyTexts: string[] = [];
    const turnTokenCounts: Promise<number>[] = [];
    const actStarted = performance.now();
    let firstTokenMs: number | undefined;

    await this.#model.act(this.#snapshot(), tools, {
      onMessage: (msg) => {
        observer?.onMessage();
        const message = this.#appendAssistant(msg);
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

    const turnTokens = (await Promise.all(turnTokenCounts)).reduce((sum, n) => sum + n, 0);
    const compacted = await this.#finalizeTurn();

    return {
      replyTexts,
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

  #appendUser(text: string): ChatMessage {
    this.#markDirty();
    return this.#append("user", text);
  }

  #appendAssistant(message: ChatMessage): ChatMessage {
    this.#markDirty();
    return this.#append(message);
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

  async #refreshTokenCount(): Promise<number> {
    const messages = this.#chat.getMessagesArray();
    const counts = await Promise.all(messages.map((m) => countTokensForMessage(this.#model, m)));
    this.#tokenCount = counts.reduce((sum, n) => sum + n, 0);
    return this.#tokenCount;
  }

  async #finalizeTurn(): Promise<boolean> {
    await this.#refreshTokenCount();
    let compacted = false;
    if (this.#shouldCompact()) {
      await this.#compact();
      compacted = true;
    }
    return compacted;
  }

  #shouldCompact(): boolean {
    return this.#tokenCount > this.#maxContextLength * this.#compactPercentage;
  }

  async #compact(): Promise<void> {
    await traceSpan("context.compact", async (span) => {
      const before = this.#tokenCount;
      this.#chat = await this.#compactor(this.#chat);
      this.#chat.replaceSystemPrompt(this.#systemPrompt);
      await this.#refreshTokenCount();
      span.setAttributes({
        "context.tokens.before": before,
        "context.tokens.after": this.#tokenCount,
      });
      logDebug("context.compact", { before, after: this.#tokenCount });
    });
  }

  #exportMessages(): ChatMessageData[] {
    return this.#chat.getMessagesArray().map(messageToData);
  }

  #markDirty(): void {
    this.#dirty = true;
  }
}
