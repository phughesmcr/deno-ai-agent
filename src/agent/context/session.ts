import type { EventStore, KvSessionCatalog, SessionCompactionResult, SessionContextEngine } from "../../core/mod.ts";

export type { ContextSummaryPort, SessionCompactionResult } from "../../core/mod.ts";

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
  /** Whether the current session exists in the durable session catalog. */
  persisted: boolean;
  /** Number of messages in context. */
  messageCount: number;
  /** Estimated token count for the context. */
  tokenCount: number;
  /** Model context window size. */
  maxContextLength: number;
}

/**
 * Caller-facing session API.
 * @internal
 */
export interface AgentSessions {
  /** Current in-memory session identity. */
  readonly current: { id: string; name?: string };

  /** Starts a fresh in-memory session without saving the previous one. */
  readonly new: () => SessionStatus;
  /** Ensures the current session exists in the durable catalog. */
  save(): Promise<SessionStatus>;
  /** Loads a saved session by id or name. */
  load(ref: string): Promise<SessionStatus>;
  /** Saves the current session and branches into a fresh session id. */
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

interface DurableAgentSessionsOptions {
  events: EventStore;
  catalog: KvSessionCatalog;
  context: SessionContextEngine;
  systemPrompt: string;
  maxContextLength: number;
}

/**
 * Event-sourced v4 session facade backed by Deno KV metadata and append-only events.
 * @internal
 */
export class DurableAgentSessions implements AgentSessions {
  private readonly _events: EventStore;
  private readonly _catalog: KvSessionCatalog;
  private readonly _context: SessionContextEngine;
  private readonly _maxContextLength: number;
  private _id: string = crypto.randomUUID();
  private _name: string | undefined;
  private _existsInCatalog = false;
  private _systemPrompt: string;
  private _tokenCount = 0;
  private _messageCount = 1;

  /** Creates a durable v4 session facade. */
  constructor(options: DurableAgentSessionsOptions) {
    this._events = options.events;
    this._catalog = options.catalog;
    this._context = options.context;
    this._systemPrompt = options.systemPrompt;
    this._maxContextLength = options.maxContextLength;
  }

  get current(): { id: string; name?: string } {
    return this._name ? { id: this._id, name: this._name } : { id: this._id };
  }

  new(): SessionStatus {
    this._id = crypto.randomUUID();
    this._name = undefined;
    this._existsInCatalog = false;
    this._tokenCount = 0;
    this._messageCount = 1;
    return this._status();
  }

  /** Ensures the current session exists in the v4 catalog. */
  async save(): Promise<SessionStatus> {
    await this._ensureCatalogRecord();
    return await this.status({ refresh: true });
  }

  /** Loads a v4 session by id or name. */
  async load(ref: string): Promise<SessionStatus> {
    const record = await this._catalog.resolve(ref);
    this._id = record.id;
    this._name = record.name;
    this._existsInCatalog = true;
    return await this.status({ refresh: true });
  }

  /** Forks the current session metadata and copies replayable v4 events to the fork. */
  async fork(): Promise<{ from: SessionStatus; to: SessionStatus }> {
    const from = await this.save();
    const sourceId = this._id;
    const record = await this._catalog.fork(sourceId);
    const sourceEvents = await this._events.listBySession(sourceId);
    this._id = record.id;
    this._name = record.name;
    this._existsInCatalog = true;
    for (const event of sourceEvents) {
      if (
        event.category !== "turn.input" &&
        event.category !== "model.message" &&
        event.category !== "session.compacted"
      ) continue;
      await this._events.append({
        category: event.category,
        sessionId: record.id,
        payload: structuredClone(event.payload),
      });
    }
    const to = await this.status({ refresh: true });
    return { from, to };
  }

  /** Renames the current v4 session, or stages a name before first save. */
  async rename(name: string): Promise<SessionStatus> {
    if (this._existsInCatalog) {
      const record = await this._catalog.rename(this._id, name);
      this._name = record.name;
    } else {
      this._name = name;
    }
    return this._status();
  }

  /** Lists v4 sessions from the catalog. */
  async list(): Promise<SavedSessionSummary[]> {
    return (await this._catalog.list()).map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      name: record.name,
    }));
  }

  /** Returns current v4 session status. */
  async status(options?: { refresh?: boolean }): Promise<SessionStatus> {
    if (options?.refresh) await this._refreshTokenCount();
    return this._status();
  }

  /** Appends a manual v4 compaction event. */
  async compact(options?: { instructions?: string }): Promise<SessionCompactionResult> {
    await this._ensureCatalogRecord();
    const result = await this._context.compact({
      sessionId: this._id,
      baseSystemPrompt: this._systemPrompt,
      reason: "manual",
      instructions: options?.instructions,
    });
    this._tokenCount = result.afterTokens;
    this._messageCount = result.messageCount;
    return result;
  }

  /** Applies a new system prompt for future projections. */
  async applySystemPrompt(prompt: string): Promise<SessionStatus> {
    this._systemPrompt = prompt;
    await this._refreshTokenCount();
    return this._status();
  }

  async _ensureCatalogRecord(): Promise<void> {
    if (this._existsInCatalog) return;
    const record = await this._catalog.create({ id: this._id, name: this._name });
    this._id = record.id;
    this._name = record.name;
    this._existsInCatalog = true;
  }

  async _refreshTokenCount(): Promise<number> {
    const count = await this._context.countContext({
      sessionId: this._id,
      baseSystemPrompt: this._systemPrompt,
    });
    this._tokenCount = count.tokenCount;
    this._messageCount = count.messageCount;
    return this._tokenCount;
  }

  _status(): SessionStatus {
    return {
      id: this._id,
      name: this._name,
      persisted: this._existsInCatalog,
      messageCount: this._messageCount,
      tokenCount: this._tokenCount,
      maxContextLength: this._maxContextLength,
    };
  }
}
