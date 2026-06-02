import type { ChatMessageData } from "@lmstudio/sdk";

/** Session file format version. */
export const FORMAT_VERSION = 1 as const;

/**
 * On-disk session file (version 1).
 * @internal
 */
export interface SessionFile {
  /** File format version. */
  version: typeof FORMAT_VERSION;
  /** Session identifier. */
  id: string;
  /** ISO timestamp when the file was written. */
  savedAt: string;
  /** Serialized chat messages. */
  messages: ChatMessageData[];
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

function assertValidSessionId(id: string): void {
  if (!isValidSessionId(id)) throw new Error("Invalid session id");
}

/**
 * Reads and writes `{workspace}/sessions/{id}.json`.
 * @internal
 */
export class SessionStore {
  readonly #dir: string;

  /** @param sessionsDir Directory containing `{id}.json` session files. */
  constructor(sessionsDir: string) {
    this.#dir = sessionsDir;
  }

  /** Writes messages to `{id}.json`. */
  async save(id: string, messages: ChatMessageData[]): Promise<void> {
    assertValidSessionId(id);
    const file: SessionFile = {
      version: FORMAT_VERSION,
      id,
      savedAt: new Date().toISOString(),
      messages,
    };
    await Deno.writeTextFile(this.#path(id), JSON.stringify(file, null, 2));
  }

  /** Reads messages from `{id}.json`. */
  async load(id: string): Promise<ChatMessageData[]> {
    assertValidSessionId(id);
    const json = await Deno.readTextFile(this.#path(id));
    return decodeSessionFile(json, id);
  }

  /** Lists session ids (filenames without `.json`). */
  async list(): Promise<string[]> {
    const entries = await Array.fromAsync(Deno.readDir(this.#dir));
    return entries
      .filter((entry) => entry.isFile && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, ""))
      .filter(isValidSessionId)
      .toSorted();
  }

  /** Returns whether `{id}.json` exists. */
  async exists(id: string): Promise<boolean> {
    assertValidSessionId(id);
    try {
      await Deno.stat(this.#path(id));
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  #path(id: string): string {
    return `${this.#dir}/${id}.json`;
  }
}

/**
 * Parses v1 session files.
 * @internal
 */
function decodeSessionFile(json: string, expectedId: string): ChatMessageData[] {
  const parsed: unknown = JSON.parse(json);

  if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === FORMAT_VERSION) {
    const file = parsed as SessionFile;
    if (file.id !== expectedId) {
      throw new Error(`Session file id mismatch: expected ${expectedId}, got ${file.id}`);
    }
    if (!Array.isArray(file.messages)) throw new Error("Invalid session JSON");
    return file.messages;
  }

  throw new Error("Invalid session JSON");
}
