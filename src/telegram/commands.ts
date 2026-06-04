import { type AgentSessions, copyTodosForSession, type SavedSessionSummary, type SessionStatus } from "../agent/mod.ts";

/** One-line help text for supported session commands. */
export const SESSION_HELP =
  "Sessions: /new - fresh chat | /save - write to disk | /load <id|name> - restore | /resume <id|name> - alias for load | /rename <name> - label session | /fork - branch copy | /list - saved sessions | /session - status | /stats - tokens | /compact [instructions] - summarize history | /todos - task list";

interface CommandSession {
  readonly current: { id: string; name?: string };
  status(options?: { refresh?: boolean }): Promise<SessionStatus>;
  readonly new: () => SessionStatus;
  save(): Promise<SessionStatus>;
  load(ref: string): Promise<SessionStatus>;
  rename(name: string): Promise<SessionStatus>;
  fork(): Promise<{ from: SessionStatus; to: SessionStatus }>;
  list(): Promise<SavedSessionSummary[]>;
  compact(
    options?: { instructions?: string },
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }>;
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

/**
 * Command behavior independent of Grammy.
 * @internal
 */
export class TelegramCommandHandler {
  private readonly _session: CommandSession;
  private readonly _todosDir?: string;

  constructor(session: AgentSessions, todosDir?: string) {
    this._session = session;
    this._todosDir = todosDir;
  }

  help(): string {
    return SESSION_HELP;
  }

  newSession(): string {
    const status = this._session.new();
    return `New session.\nID: ${status.id}\n\nUse /save to persist.`;
  }

  async session(): Promise<string> {
    return formatSessionStatus(await this._session.status());
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
      if (this._todosDir) {
        await copyTodosForSession(this._todosDir, from.id, to.id);
      }
      return `Forked.\nFrom: ${from.id}\nTo: ${to.id}\n\nUse /save on the new branch when ready.`;
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
    const current = this._session.current.id;
    const lines = sessions.map((summary) => formatListLine(summary, current));
    return `Saved sessions:\n${lines.join("\n")}`;
  }
}
