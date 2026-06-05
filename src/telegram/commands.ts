import { copyTodosForSession, type SavedSessionSummary, type SessionStatus, type TodoStore } from "../agent/mod.ts";

/** One-line help text for supported session commands. */
export const SESSION_HELP =
  "Sessions: /topic <name> - create forum topic | /topics - known topic sessions | /new - fresh chat | /save - write to disk | /load <id|name> - restore | /resume <id|name> - alias for load | /rename <name> - label session | /fork - branch copy | /list - saved sessions | /session - status | /stats - tokens | /compact [instructions] - summarize history | /todos - task list";

/** Telegram topic binding summary shown by `/topics`. */
export interface TelegramTopicBindingSummary {
  /** Telegram chat id. */
  chatId: number;
  /** Telegram forum topic thread id, when this is not the main chat. */
  threadId?: number;
  /** Bound Silas session id. */
  sessionId: string;
  /** ISO timestamp for initial binding creation. */
  createdAt: string;
  /** ISO timestamp for the latest binding update. */
  updatedAt: string;
  /** Telegram forum topic name, when known. */
  topicName?: string;
}

/** Session operations required by Telegram command handling. */
export interface CommandSession {
  /** Returns current session status; refreshes token counts when requested. */
  status(options?: { refresh?: boolean }): Promise<SessionStatus>;
  /** Creates a fresh session and binds it to the current Telegram conversation. */
  newSession(): Promise<SessionStatus>;
  /** Persists the current session. */
  save(): Promise<SessionStatus>;
  /** Loads a saved session by id or name. */
  load(ref: string): Promise<SessionStatus>;
  /** Renames the current session. */
  rename(name: string): Promise<SessionStatus>;
  /** Forks the current session and returns source and target statuses. */
  fork(): Promise<{ from: SessionStatus; to: SessionStatus }>;
  /** Lists saved sessions. */
  list(): Promise<SavedSessionSummary[]>;
  /** Compacts session context, optionally with user instructions. */
  compact(
    options?: { instructions?: string },
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }>;
  /** Lists Telegram topic bindings for the current chat, when configured. */
  listBindings?(): Promise<TelegramTopicBindingSummary[]>;
}

function formatSessionLabel(status: Pick<SessionStatus, "id" | "name">): string {
  return status.name ? `${status.name} (${status.id})` : status.id;
}

/** Formats session status for Telegram commands. */
export function formatSessionStatus(status: SessionStatus): string {
  const filled = Math.round((status.tokenCount / status.maxContextLength) * 100);
  const persist = status.existsOnDisk ?
    (status.dirty ? "saved (unsaved changes)" : "saved") :
    (status.dirty ? "not saved (unsaved changes)" : "not saved");
  return [
    `Session: ${formatSessionLabel(status)}`,
    `State: ${persist}`,
    `Messages: ${status.messageCount}`,
    `Tokens: ${status.tokenCount} / ${status.maxContextLength} (${filled}%)`,
  ].join("\n");
}

function formatListLine(summary: SavedSessionSummary, currentId: string): string {
  const label = summary.name ? `${summary.name} - ${summary.id}` : summary.id;
  return summary.id === currentId ? `${label} (current)` : label;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatThreadLabel(binding: TelegramTopicBindingSummary): string {
  if (binding.topicName) {
    return binding.threadId === undefined ? binding.topicName : `${binding.topicName} #${binding.threadId}`;
  }
  return binding.threadId === undefined ? "main" : `topic #${binding.threadId}`;
}

function formatBindingLine(binding: TelegramTopicBindingSummary): string {
  return `${formatThreadLabel(binding)} -> ${binding.sessionId}`;
}

/**
 * Command behavior independent of Grammy.
 * @internal
 */
export class TelegramCommandHandler {
  private readonly _session: CommandSession;
  private readonly _todoStore?: TodoStore;

  constructor(session: CommandSession, todoStore?: TodoStore) {
    this._session = session;
    this._todoStore = todoStore;
  }

  help(): string {
    return SESSION_HELP;
  }

  async newSession(): Promise<string> {
    const status = await this._session.newSession();
    return `New session bound to this Telegram conversation.\nID: ${status.id}`;
  }

  async session(): Promise<string> {
    return formatSessionStatus(await this._session.status());
  }

  async sessionStatus(): Promise<SessionStatus> {
    return await this._session.status();
  }

  async stats(): Promise<string> {
    return formatSessionStatus(await this._session.status({ refresh: true }));
  }

  async compact(instructions?: string): Promise<string> {
    try {
      const result = await this._session.compact({ instructions });
      const state = result.compacted ? "Compacted." : "Nothing to compact.";
      return [
        state,
        `Tokens before: ${result.beforeTokens}`,
        `Tokens after: ${result.afterTokens}`,
      ].join("\n");
    } catch (error) {
      return `Compaction failed: ${errorMessage(error)}`;
    }
  }

  async fork(): Promise<string> {
    try {
      const { from, to } = await this._session.fork();
      if (this._todoStore) {
        await copyTodosForSession(this._todoStore, from.id, to.id);
      }
      return `Forked and rebound this Telegram conversation.\nFrom: ${from.id}\nTo: ${to.id}`;
    } catch (error) {
      return `Fork failed: ${errorMessage(error)}`;
    }
  }

  async load(ref?: string): Promise<string> {
    if (!ref) return "Usage: /load <id|name>\n\n/list shows saved sessions.";
    try {
      const status = await this._session.load(ref);
      return `Loaded session ${formatSessionLabel(status)}.\n\n${formatSessionStatus(status)}`;
    } catch (error) {
      return `Load failed: ${errorMessage(error)}`;
    }
  }

  async rename(name?: string): Promise<string> {
    if (!name) return "Usage: /rename <name>";
    try {
      const status = await this._session.rename(name);
      return `Renamed session to "${name}".\n${formatSessionLabel(status)}`;
    } catch (error) {
      return `Rename failed: ${errorMessage(error)}`;
    }
  }

  async save(): Promise<string> {
    try {
      const status = await this._session.save();
      const label = formatSessionLabel(status);
      return `Saved.\n${label}`;
    } catch (error) {
      return `Save failed: ${errorMessage(error)}`;
    }
  }

  async list(): Promise<string> {
    const sessions = await this._session.list();
    if (sessions.length === 0) return "No saved sessions. /save writes the current chat.";
    const current = (await this._session.status()).id;
    const lines = sessions.map((summary) => formatListLine(summary, current));
    return `Saved sessions:\n${lines.join("\n")}`;
  }

  async topics(): Promise<string> {
    if (!this._session.listBindings) return "Topic sessions are not configured.";
    const bindings = await this._session.listBindings();
    if (bindings.length === 0) return "No known topic sessions for this chat.";
    return `Known topic sessions:\n${bindings.map(formatBindingLine).join("\n")}`;
  }
}
