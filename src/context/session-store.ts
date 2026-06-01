import type { ChatMessageData } from "@lmstudio/sdk";

const FORMAT_VERSION = 1 as const;

/** On-disk session file (version 1). */
export interface SessionFile {
  version: typeof FORMAT_VERSION;
  id: string;
  savedAt: string;
  messages: ChatMessageData[];
}

/** @internal SDK exposes getRaw() at runtime but not in public types. */
interface LegacyWrappedMessage {
  data: ChatMessageData;
}

interface LegacyMessagesOnly {
  messages: ChatMessageData[];
}

/** Reads and writes `{workspace}/sessions/{id}.json`. */
export class SessionStore {
  readonly #dir: string;

  constructor(sessionsDir: string) {
    this.#dir = sessionsDir;
  }

  async save(id: string, messages: ChatMessageData[]): Promise<void> {
    const file: SessionFile = {
      version: FORMAT_VERSION,
      id,
      savedAt: new Date().toISOString(),
      messages,
    };
    await Deno.writeTextFile(this.#path(id), JSON.stringify(file, null, 2));
  }

  async load(id: string): Promise<ChatMessageData[]> {
    const json = await Deno.readTextFile(this.#path(id));
    return parseSessionFile(json, id);
  }

  async list(): Promise<string[]> {
    const entries = await Array.fromAsync(Deno.readDir(this.#dir));
    return entries
      .filter((entry) => entry.isFile && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, ""))
      .toSorted();
  }

  async exists(id: string): Promise<boolean> {
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

/** Parses v1 session files and legacy exports. */
export function parseSessionFile(json: string, expectedId?: string): ChatMessageData[] {
  const parsed: unknown = JSON.parse(json);

  if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === FORMAT_VERSION) {
    const file = parsed as SessionFile;
    if (expectedId && file.id !== expectedId) {
      throw new Error(`Session file id mismatch: expected ${expectedId}, got ${file.id}`);
    }
    return file.messages;
  }

  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first && typeof first === "object" && "data" in first) {
      return (parsed as LegacyWrappedMessage[]).map((item) => item.data);
    }
    return parsed as ChatMessageData[];
  }

  if (parsed && typeof parsed === "object" && "messages" in parsed && Array.isArray(parsed.messages)) {
    return (parsed as LegacyMessagesOnly).messages;
  }

  throw new Error("Invalid session JSON");
}
