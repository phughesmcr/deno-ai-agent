import type { ChatMessage } from "@lmstudio/sdk";

import type { Workspace } from "../workspace.ts";
import type { ChatContext } from "./chat-context.ts";
import type { SessionStore } from "./session-store.ts";

export interface SessionStatus {
  id: string;
  dirty: boolean;
  saved: boolean;
  messageCount: number;
  tokenCount: number;
  maxContextLength: number;
}

export interface TurnResult {
  tokenCount: number;
  compacted: boolean;
}

interface SessionManagerOptions {
  chat: ChatContext;
  store: SessionStore;
  workspace: Workspace;
}

/**
 * User-facing session: new / save / load / fork plus LM Studio chat state.
 * @internal
 */
export class SessionManager {
  readonly chat: ChatContext;
  readonly #store: SessionStore;
  readonly workspace: Workspace;

  #id: string;
  #dirty = false;
  #saved = false;

  constructor(spec: SessionManagerOptions) {
    this.chat = spec.chat;
    this.#store = spec.store;
    this.workspace = spec.workspace;
    this.#id = crypto.randomUUID();
  }

  get id(): string {
    return this.#id;
  }

  status(): SessionStatus {
    return {
      id: this.#id,
      dirty: this.#dirty,
      saved: this.#saved,
      messageCount: this.chat.messageCount,
      tokenCount: this.chat.tokenCount,
      maxContextLength: this.chat.maxContextLength,
    };
  }

  async applySystemPrompt(prompt: string): Promise<void> {
    this.chat.replaceSystemPrompt(prompt);
    await this.chat.refreshTokenCount();
    this.#markDirty();
  }

  /** Starts a new in-memory session (does not write the previous one). */
  newSession(): string {
    this.chat.clear();
    this.#id = crypto.randomUUID();
    this.#dirty = false;
    this.#saved = false;
    return this.#id;
  }

  async save(): Promise<string> {
    await this.#store.save(this.#id, this.chat.exportMessages());
    this.#dirty = false;
    this.#saved = true;
    return this.#id;
  }

  async load(id: string): Promise<void> {
    if (!(await this.#store.exists(id))) {
      throw new Error(`Session not found: ${id}`);
    }
    const messages = await this.#store.load(id);
    this.chat.loadMessages(messages);
    await this.chat.refreshTokenCount();
    this.#id = id;
    this.#dirty = false;
    this.#saved = true;
  }

  /** Saves the current session, then branches into a new id with the same history. */
  async fork(): Promise<{ fromId: string; toId: string }> {
    const fromId = this.#id;
    if (this.#dirty || !this.#saved) {
      await this.save();
    }
    const messages = this.chat.exportMessages();
    this.#id = crypto.randomUUID();
    this.chat.loadMessages(messages);
    await this.chat.refreshTokenCount();
    this.#dirty = true;
    this.#saved = false;
    return { fromId, toId: this.#id };
  }

  async list(): Promise<string[]> {
    return await this.#store.list();
  }

  appendUser(text: string): ChatMessage {
    this.#markDirty();
    return this.chat.append("user", text);
  }

  appendAssistant(message: ChatMessage): ChatMessage {
    this.#markDirty();
    return this.chat.append(message);
  }

  /** Refreshes token count and compacts when over budget. */
  async finalizeTurn(): Promise<TurnResult> {
    await this.chat.refreshTokenCount();
    let compacted = false;
    if (this.chat.shouldCompact) {
      await this.chat.compact();
      compacted = true;
    }
    return { tokenCount: this.chat.tokenCount, compacted };
  }

  #markDirty(): void {
    this.#dirty = true;
    this.#saved = false;
  }
}
