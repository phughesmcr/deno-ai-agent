import type {
  AgentSessions,
  SavedSessionSummary,
  SessionCompactionResult,
  SessionStatus,
  SessionTurnOptions,
  SessionTurnResult,
} from "../agent/mod.ts";
import type { UserTurnInput } from "../agent/user-turn.ts";
import type { TelegramConversationRef } from "./conversation.ts";
import type { TelegramSessionBinding, TelegramSessionBindingStore } from "./session-binding-store.ts";

interface BindMetadata {
  createdBy?: number;
  topicName?: string;
}

export interface TelegramSessionResolution {
  binding: TelegramSessionBinding;
  created: boolean;
}

/** Session operations bound to one Telegram conversation. */
export interface TelegramConversationSession {
  status(options?: { refresh?: boolean }): Promise<SessionStatus>;
  newSession(): Promise<SessionStatus>;
  save(): Promise<SessionStatus>;
  load(ref: string): Promise<SessionStatus>;
  rename(name: string): Promise<SessionStatus>;
  fork(): Promise<{ from: SessionStatus; to: SessionStatus }>;
  list(): Promise<SavedSessionSummary[]>;
  compact(options?: { instructions?: string }): Promise<SessionCompactionResult>;
  listBindings(): Promise<TelegramSessionBinding[]>;
}

type QueuedOperation<T> = () => Promise<T> | T;

/**
 * Routes Telegram conversations through the single mutable AgentSessions facade.
 * All operations are serialized because v1 shares one workspace and one in-memory session object.
 */
export class TelegramSessionCoordinator {
  private readonly _sessions: AgentSessions;
  private readonly _bindings: TelegramSessionBindingStore;
  private _queue: Promise<void> = Promise.resolve();

  constructor(options: { sessions: AgentSessions; bindings: TelegramSessionBindingStore }) {
    this._sessions = options.sessions;
    this._bindings = options.bindings;
  }

  /** Ensures a conversation has a durable saved session and loads it into the facade. */
  async ensure(ref: TelegramConversationRef, metadata?: BindMetadata): Promise<TelegramSessionResolution> {
    return await this._exclusive(() => this._ensureLoaded(ref, metadata));
  }

  /** Runs a model turn in the session bound to this Telegram conversation. */
  async turn(
    ref: TelegramConversationRef,
    input: string | UserTurnInput,
    options: SessionTurnOptions,
    metadata?: BindMetadata,
  ): Promise<SessionTurnResult> {
    return await this._exclusive(async () => {
      await this._ensureLoaded(ref, metadata);
      return await this._sessions.turn(input, options);
    });
  }

  /** Runs custom work with the session for a conversation loaded and the global lock held. */
  async withConversation<T>(
    ref: TelegramConversationRef,
    operation: QueuedOperation<T>,
    metadata?: BindMetadata,
  ): Promise<T> {
    return await this._exclusive(async () => {
      await this._ensureLoaded(ref, metadata);
      return await operation();
    });
  }

  /** Returns command-style session operations scoped to a Telegram conversation. */
  forConversation(ref: TelegramConversationRef, metadata?: BindMetadata): TelegramConversationSession {
    return {
      status: (options) => this.withConversation(ref, () => this._sessions.status(options), metadata),
      newSession: () => this.replaceWithNew(ref, metadata),
      save: () => this.withConversation(ref, () => this._sessions.save(), metadata),
      load: (sessionRef) => this.loadForConversation(ref, sessionRef, metadata),
      rename: (name) => this.withConversation(ref, () => this._sessions.rename(name), metadata),
      fork: () => this.forkForConversation(ref, metadata),
      list: () => this.withConversation(ref, () => this._sessions.list(), metadata),
      compact: (options) => this.withConversation(ref, () => this._sessions.compact(options), metadata),
      listBindings: () => this._bindings.listForChat(ref.chatId),
    };
  }

  /** Replaces a conversation binding with a freshly saved session. */
  async replaceWithNew(ref: TelegramConversationRef, metadata?: BindMetadata): Promise<SessionStatus> {
    return await this._exclusive(async () => {
      const status = await this._createSavedSession();
      await this._bindings.bind(ref, {
        sessionId: status.id,
        createdBy: metadata?.createdBy,
        topicName: metadata?.topicName,
      });
      return status;
    });
  }

  /** Loads a saved session and binds this Telegram conversation to it. */
  async loadForConversation(
    ref: TelegramConversationRef,
    sessionRef: string,
    metadata?: BindMetadata,
  ): Promise<SessionStatus> {
    return await this._exclusive(async () => {
      const status = await this._sessions.load(sessionRef);
      await this._bindings.bind(ref, {
        sessionId: status.id,
        createdBy: metadata?.createdBy,
        topicName: metadata?.topicName,
      });
      return status;
    });
  }

  /** Forks the current bound session, saves the fork, and rebinds this Telegram conversation to it. */
  async forkForConversation(
    ref: TelegramConversationRef,
    metadata?: BindMetadata,
  ): Promise<{ from: SessionStatus; to: SessionStatus }> {
    return await this._exclusive(async () => {
      await this._ensureLoaded(ref, metadata);
      const forked = await this._sessions.fork();
      const savedTo = await this._sessions.save();
      await this._bindings.bind(ref, {
        sessionId: savedTo.id,
        createdBy: metadata?.createdBy,
        topicName: metadata?.topicName,
      });
      return { from: forked.from, to: savedTo };
    });
  }

  async _ensureLoaded(ref: TelegramConversationRef, metadata?: BindMetadata): Promise<TelegramSessionResolution> {
    const existing = await this._bindings.get(ref);
    if (existing) {
      await this._sessions.load(existing.sessionId);
      return { binding: existing, created: false };
    }

    const status = await this._createSavedSession();
    const resolution = await this._bindings.createIfMissing(ref, {
      sessionId: status.id,
      createdBy: metadata?.createdBy,
      topicName: metadata?.topicName,
    });
    if (!resolution.created) await this._sessions.load(resolution.binding.sessionId);
    return resolution;
  }

  async _createSavedSession(): Promise<SessionStatus> {
    this._sessions.new();
    return await this._sessions.save();
  }

  async _exclusive<T>(operation: QueuedOperation<T>): Promise<T> {
    const previous = this._queue;
    const gate = Promise.withResolvers<void>();
    this._queue = gate.promise;
    await previous;
    try {
      return await operation();
    } finally {
      gate.resolve();
    }
  }
}
