import type { ChatMessageData } from "@lmstudio/sdk";

/** Session event-log file format version. */
export const FORMAT_VERSION = 3 as const;

const LEGACY_FORMAT_VERSION = 2 as const;

/**
 * File details carried by compaction checkpoints.
 * @internal
 */
export interface SessionFileDetails {
  /** Files read during the session, when recoverable from tool calls. */
  readFiles: string[];
  /** Files modified during the session, when recoverable from tool calls. */
  modifiedFiles: string[];
}

/**
 * First line in a session JSONL file (v2 or v3).
 * @internal
 */
export interface SessionHeader {
  /** Event-log format version. */
  version: typeof FORMAT_VERSION | typeof LEGACY_FORMAT_VERSION;
  /** Session identifier. */
  id: string;
  /** ISO timestamp when the session log was created. */
  createdAt: string;
  /** User-facing alias for `/resume <name>`. */
  name?: string;
}

/**
 * Persisted chat message event.
 * @internal
 */
export interface SessionMessageEntry {
  /** Entry discriminator. */
  type: "message";
  /** Stable entry identifier. */
  id: string;
  /** ISO timestamp when the message was appended. */
  createdAt: string;
  /** Serialized LM Studio chat message. */
  message: ChatMessageData;
}

/**
 * Persisted context compaction checkpoint.
 * @internal
 */
export interface SessionCompactionEntry {
  /** Entry discriminator. */
  type: "compaction";
  /** Stable entry identifier. */
  id: string;
  /** ISO timestamp when the checkpoint was appended. */
  createdAt: string;
  /** Structured checkpoint summary. */
  summary: string;
  /** First raw message entry retained after this checkpoint, or null when none is retained. */
  firstKeptEntryId: string | null;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Estimated context tokens after compaction. */
  tokensAfter: number;
  /** Whether this checkpoint came from automatic or manual compaction. */
  reason: "auto" | "manual";
  /** Cumulative practical file context. */
  details: SessionFileDetails;
}

/**
 * Append-only session event.
 * @internal
 */
export type SessionEntry = SessionMessageEntry | SessionCompactionEntry;

/**
 * Complete session event log.
 * @internal
 */
export interface SessionLog {
  /** Session JSONL header. */
  header: SessionHeader;
  /** Append-only session entries after the header. */
  entries: SessionEntry[];
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name) && !isValidSessionId(name);
}

function assertValidSessionId(id: string): void {
  if (!isValidSessionId(id)) throw new Error("Invalid session id");
}

function assertValidSessionName(name: string): void {
  if (!isValidSessionName(name)) throw new Error("Invalid session name");
}

function isSupportedHeaderVersion(version: unknown): version is SessionHeader["version"] {
  return version === FORMAT_VERSION || version === LEGACY_FORMAT_VERSION;
}

function assertSessionHeader(value: unknown, expectedId: string): asserts value is SessionHeader {
  if (!value || typeof value !== "object") throw new Error("Invalid session JSONL header");
  const header = value as Partial<SessionHeader>;
  if (!isSupportedHeaderVersion(header.version)) throw new Error("Invalid session JSONL header");
  if (header.id !== expectedId) throw new Error(`Session file id mismatch: expected ${expectedId}, got ${header.id}`);
  if (typeof header.createdAt !== "string") throw new Error("Invalid session JSONL header");
  if (header.name !== undefined) {
    if (typeof header.name !== "string") throw new Error("Invalid session JSONL header");
    assertValidSessionName(header.name);
  }
}

function serializeHeader(header: SessionHeader): string {
  const payload: Record<string, string | number> = {
    version: FORMAT_VERSION,
    id: header.id,
    createdAt: header.createdAt,
  };
  if (header.name !== undefined) payload["name"] = header.name;
  return JSON.stringify(payload);
}

function assertFileDetails(value: unknown): asserts value is SessionFileDetails {
  if (!value || typeof value !== "object") throw new Error("Invalid compaction details");
  const details = value as Partial<SessionFileDetails>;
  if (!Array.isArray(details.readFiles) || !details.readFiles.every((item) => typeof item === "string")) {
    throw new Error("Invalid compaction details");
  }
  if (!Array.isArray(details.modifiedFiles) || !details.modifiedFiles.every((item) => typeof item === "string")) {
    throw new Error("Invalid compaction details");
  }
}

function assertSessionEntry(value: unknown, line: number): asserts value is SessionEntry {
  if (!value || typeof value !== "object") throw new Error(`Invalid session JSONL entry at line ${line}`);
  const entry = value as Partial<SessionEntry>;
  if (entry.type === "message") {
    if (typeof entry.id !== "string" || typeof entry.createdAt !== "string") {
      throw new Error(`Invalid message entry at line ${line}`);
    }
    if (!entry.message || typeof entry.message !== "object" || !("role" in entry.message)) {
      throw new Error(`Invalid message entry at line ${line}`);
    }
    return;
  }

  if (entry.type === "compaction") {
    if (
      typeof entry.id !== "string" ||
      typeof entry.createdAt !== "string" ||
      typeof entry.summary !== "string" ||
      (typeof entry.firstKeptEntryId !== "string" && entry.firstKeptEntryId !== null) ||
      typeof entry.tokensBefore !== "number" ||
      typeof entry.tokensAfter !== "number" ||
      (entry.reason !== "auto" && entry.reason !== "manual")
    ) {
      throw new Error(`Invalid compaction entry at line ${line}`);
    }
    assertFileDetails(entry.details);
    return;
  }

  throw new Error(`Invalid session JSONL entry at line ${line}`);
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid session JSONL at line ${lineNumber}: ${message}`);
  }
}

/**
 * Reads and appends `{workspace}/sessions/{id}.jsonl`.
 * @internal
 */
export class SessionStore {
  readonly #dir: string;

  /** @param sessionsDir Directory containing `{id}.jsonl` session files. */
  constructor(sessionsDir: string) {
    this.#dir = sessionsDir;
  }

  /** Creates an empty v3 session log if it does not already exist. */
  async create(id: string, options?: { name?: string }): Promise<void> {
    assertValidSessionId(id);
    if (await this.exists(id)) return;
    const name = options?.name;
    if (name !== undefined) {
      assertValidSessionName(name);
      await this.#assertNameAvailable(name);
    }
    const header: SessionHeader = {
      version: FORMAT_VERSION,
      id,
      createdAt: new Date().toISOString(),
      ...(name !== undefined ? { name } : {}),
    };
    await Deno.writeTextFile(this.#path(id), `${serializeHeader(header)}\n`, { createNew: true });
  }

  /** Appends one entry to an existing session log. */
  async append(id: string, entry: SessionEntry): Promise<void> {
    assertValidSessionId(id);
    await Deno.writeTextFile(this.#path(id), `${JSON.stringify(entry)}\n`, { append: true });
  }

  /** Appends multiple entries in one write to an existing session log. */
  async appendMany(id: string, entries: SessionEntry[]): Promise<void> {
    assertValidSessionId(id);
    if (entries.length === 0) return;
    const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await Deno.writeTextFile(this.#path(id), text, { append: true });
  }

  /** Reads the session JSONL header (line 1). */
  async readHeader(id: string): Promise<SessionHeader> {
    assertValidSessionId(id);
    const text = await Deno.readTextFile(this.#path(id));
    const line = text.split("\n").find((row) => row.length > 0);
    if (!line) throw new Error("Invalid session JSONL header");
    const header = parseJsonLine(line, 1);
    assertSessionHeader(header, id);
    return header;
  }

  /** Reads a session log. */
  async read(id: string): Promise<SessionLog> {
    assertValidSessionId(id);
    let text: string;
    try {
      text = await Deno.readTextFile(this.#path(id));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound && await this.legacyExists(id)) {
        throw new Error(`Legacy session ${id} is not supported. Start a new session instead.`);
      }
      throw error;
    }

    const lines = text.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) throw new Error("Invalid session JSONL header");

    const header = parseJsonLine(lines[0]!, 1);
    assertSessionHeader(header, id);

    const entries: SessionEntry[] = [];
    for (const [index, line] of lines.slice(1).entries()) {
      const lineNumber = index + 2;
      const entry = parseJsonLine(line, lineNumber);
      assertSessionEntry(entry, lineNumber);
      entries.push(entry);
    }

    return { header, entries };
  }

  /** Updates the session name in the JSONL header (rewrites the file). */
  async setName(id: string, name: string | undefined): Promise<void> {
    assertValidSessionId(id);
    if (name !== undefined) {
      assertValidSessionName(name);
      await this.#assertNameAvailable(name, id);
    }

    const log = await this.read(id);
    const header: SessionHeader = {
      version: FORMAT_VERSION,
      id: log.header.id,
      createdAt: log.header.createdAt,
      ...(name !== undefined ? { name } : {}),
    };
    const lines = [serializeHeader(header), ...log.entries.map((entry) => JSON.stringify(entry))];
    const text = lines.join("\n") + "\n";
    const tempPath = `${this.#path(id)}.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(tempPath, text);
      await Deno.rename(tempPath, this.#path(id));
    } catch (error) {
      await Deno.remove(tempPath).catch(() => undefined);
      throw error;
    }
  }

  /** Returns session ids with the given name, excluding one id when provided. */
  async findIdsByName(name: string, exceptId?: string): Promise<string[]> {
    const matches: string[] = [];
    for (const id of await this.list()) {
      if (id === exceptId) continue;
      const header = await this.readHeader(id);
      if (header.name === name) matches.push(id);
    }
    return matches;
  }

  /** Resolves a session id or saved name to a session id. */
  async resolveId(ref: string): Promise<string> {
    if (isValidSessionId(ref)) return ref;
    const matches = await this.findIdsByName(ref);
    if (matches.length === 0) throw new Error(`No saved session named "${ref}"`);
    if (matches.length > 1) throw new Error(`Ambiguous session name "${ref}"`);
    return matches[0]!;
  }

  /** Lists headers for all saved sessions (uuid sort). */
  async listHeaders(): Promise<SessionHeader[]> {
    const headers: SessionHeader[] = [];
    for (const id of await this.list()) {
      headers.push(await this.readHeader(id));
    }
    return headers;
  }

  /** Lists session ids (filenames without `.jsonl`). */
  async list(): Promise<string[]> {
    const entries = await Array.fromAsync(Deno.readDir(this.#dir));
    return entries
      .filter((entry) => entry.isFile && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name.replace(/\.jsonl$/, ""))
      .filter(isValidSessionId)
      .toSorted();
  }

  /** Returns whether `{id}.jsonl` exists. */
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

  /** Returns whether a legacy `{id}.json` exists. */
  async legacyExists(id: string): Promise<boolean> {
    assertValidSessionId(id);
    try {
      await Deno.stat(this.#legacyPath(id));
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  async #assertNameAvailable(name: string, exceptId?: string): Promise<void> {
    const matches = await this.findIdsByName(name, exceptId);
    if (matches.length > 0) throw new Error("Session name already in use");
  }

  #path(id: string): string {
    return `${this.#dir}/${id}.jsonl`;
  }

  #legacyPath(id: string): string {
    return `${this.#dir}/${id}.json`;
  }
}
