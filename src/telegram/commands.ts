import { copyTodosForSession, type SessionManager, type SessionStatus } from "../agent/mod.ts";

/** One-line help text for supported session commands. */
export const SESSION_HELP =
  "Sessions: /new - fresh chat | /save - write to disk | /load <id> - restore | /fork - branch copy | /list - saved ids | /session - status | /stats - tokens | /compact [instructions] - summarize history | /todos - task list";

interface CommandSession {
  readonly id: string;
  status(): SessionStatus;
  refreshStatus(): Promise<SessionStatus>;
  newSession(): string;
  save(): Promise<string>;
  load(id: string): Promise<void>;
  fork(): Promise<{ fromId: string; toId: string }>;
  list(): Promise<string[]>;
  compact(instructions?: string): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }>;
}

/** Formats session status for Telegram commands. */
export function formatSessionStatus(status: SessionStatus): string {
  const filled = Math.round((status.tokenCount / status.maxContextLength) * 100);
  const persist = status.existsOnDisk ?
    (status.dirty ? "saved (unsaved changes)" : "saved") :
    (status.dirty ? "not saved (unsaved changes)" : "not saved");
  return [
    `Session: ${status.id}`,
    `State: ${persist}`,
    `Messages: ${status.messageCount}`,
    `Tokens: ${status.tokenCount} / ${status.maxContextLength} (${filled}%)`,
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Command behavior independent of Grammy.
 * @internal
 */
export class TelegramCommandHandler {
  readonly #session: CommandSession;
  readonly #todosDir?: string;

  constructor(session: SessionManager, todosDir?: string) {
    this.#session = session;
    this.#todosDir = todosDir;
  }

  help(): string {
    return SESSION_HELP;
  }

  newSession(): string {
    const id = this.#session.newSession();
    return `New session.\nID: ${id}\n\nUse /save to persist.`;
  }

  session(): string {
    return formatSessionStatus(this.#session.status());
  }

  async stats(): Promise<string> {
    return formatSessionStatus(await this.#session.refreshStatus());
  }

  async compact(instructions?: string): Promise<string> {
    try {
      const result = await this.#session.compact(instructions);
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
      const { fromId, toId } = await this.#session.fork();
      if (this.#todosDir) {
        await copyTodosForSession(this.#todosDir, fromId, toId);
      }
      return `Forked.\nFrom: ${fromId}\nTo: ${toId}\n\nUse /save on the new branch when ready.`;
    } catch (error) {
      return `Fork failed: ${errorMessage(error)}`;
    }
  }

  async load(id?: string): Promise<string> {
    if (!id) return "Usage: /load <session-id>\n\n/list shows saved ids.";
    try {
      await this.#session.load(id);
      return `Loaded session ${id}.\n\n${formatSessionStatus(this.#session.status())}`;
    } catch (error) {
      return `Load failed: ${errorMessage(error)}`;
    }
  }

  async save(): Promise<string> {
    try {
      const id = await this.#session.save();
      return `Saved.\nID: ${id}`;
    } catch (error) {
      return `Save failed: ${errorMessage(error)}`;
    }
  }

  async list(): Promise<string> {
    const sessions = await this.#session.list();
    if (sessions.length === 0) return "No saved sessions. /save writes the current chat.";
    const current = this.#session.id;
    const lines = sessions.map((id) => (id === current ? `${id} (current)` : id));
    return `Saved sessions:\n${lines.join("\n")}`;
  }
}
