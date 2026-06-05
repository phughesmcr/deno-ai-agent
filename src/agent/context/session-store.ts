import type { ChatMessageData } from "@lmstudio/sdk";
import { z } from "zod/v3";

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

const sessionNameSchema = z.string().regex(SESSION_NAME_PATTERN).refine((name) => !isValidSessionId(name));

const sessionHeaderSchema = z.object({
  version: z.union([z.literal(FORMAT_VERSION), z.literal(LEGACY_FORMAT_VERSION)]),
  id: z.string(),
  createdAt: z.string(),
  name: sessionNameSchema.optional(),
});

const sessionFileDetailsSchema = z.object({
  readFiles: z.array(z.string()),
  modifiedFiles: z.array(z.string()),
});

const chatMessageDataSchema = z.custom<ChatMessageData>((value) => {
  return value !== null && typeof value === "object" && "role" in value;
});

const sessionMessageEntrySchema = z.object({
  type: z.literal("message"),
  id: z.string(),
  createdAt: z.string(),
  message: chatMessageDataSchema,
});

const sessionCompactionEntrySchema = z.object({
  type: z.literal("compaction"),
  id: z.string(),
  createdAt: z.string(),
  summary: z.string(),
  firstKeptEntryId: z.string().nullable(),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  reason: z.enum(["auto", "manual"]),
  details: sessionFileDetailsSchema,
});

const sessionEntrySchema = z.discriminatedUnion("type", [
  sessionMessageEntrySchema,
  sessionCompactionEntrySchema,
]);

/** Returns true when `id` is a v4 UUID accepted as a session id. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/** Returns true when `name` is a safe user-facing session alias. */
export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name) && !isValidSessionId(name);
}

function assertValidSessionId(id: string): void {
  if (!isValidSessionId(id)) throw new Error("Invalid session id");
}

function assertValidSessionName(name: string): void {
  if (!isValidSessionName(name)) throw new Error("Invalid session name");
}

function assertSessionHeader(value: unknown, expectedId: string): asserts value is SessionHeader {
  const result = sessionHeaderSchema.safeParse(value);
  if (!result.success) throw new Error("Invalid session JSONL header");
  const header = result.data;
  if (header.id !== expectedId) throw new Error(`Session file id mismatch: expected ${expectedId}, got ${header.id}`);
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

function assertSessionEntry(value: unknown, line: number): asserts value is SessionEntry {
  const result = sessionEntrySchema.safeParse(value);
  if (result.success) return;
  const type = value !== null && typeof value === "object" && "type" in value ?
    (value as { type?: unknown }).type :
    undefined;
  if (type === "message") throw new Error(`Invalid message entry at line ${line}`);
  if (type === "compaction") throw new Error(`Invalid compaction entry at line ${line}`);
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

function sessionHeaderKey(id: string): Deno.KvKey {
  return ["sessions", "header", id];
}

function sessionNameKey(name: string): Deno.KvKey {
  return ["sessions", "name", name];
}

function parseCatalogHeader(value: unknown, id: string): SessionHeader {
  assertSessionHeader(value, id);
  return value;
}

class DenoKvSessionCatalog {
  private readonly _kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  async rebuild(headers: SessionHeader[]): Promise<void> {
    const names = new Map<string, string>();
    for (const header of headers) {
      if (!header.name) continue;
      const existing = names.get(header.name);
      if (existing && existing !== header.id) throw new Error("Session name already in use");
      names.set(header.name, header.id);
    }

    for await (const entry of this._kv.list({ prefix: ["sessions", "header"] })) {
      await this._kv.delete(entry.key);
    }
    for await (const entry of this._kv.list({ prefix: ["sessions", "name"] })) {
      await this._kv.delete(entry.key);
    }

    for (const header of headers) {
      await this.putHeader(header);
    }
  }

  async putHeader(header: SessionHeader, previousName?: string): Promise<void> {
    while (true) {
      const nameEntry = header.name ? await this._kv.get<string>(sessionNameKey(header.name)) : undefined;
      if (nameEntry?.value && nameEntry.value !== header.id) throw new Error("Session name already in use");

      let atomic = this._kv.atomic().set(sessionHeaderKey(header.id), header);
      if (previousName && previousName !== header.name) {
        atomic = atomic.delete(sessionNameKey(previousName));
      }
      if (header.name) {
        atomic = atomic.check(nameEntry!).set(sessionNameKey(header.name), header.id);
      }

      const result = await atomic.commit();
      if (result.ok) return;
    }
  }

  async deleteHeader(id: string, name?: string): Promise<void> {
    let atomic = this._kv.atomic().delete(sessionHeaderKey(id));
    if (name) atomic = atomic.delete(sessionNameKey(name));
    await atomic.commit();
  }

  async deleteName(name: string): Promise<void> {
    await this._kv.delete(sessionNameKey(name));
  }

  async getIdByName(name: string): Promise<string | undefined> {
    const entry = await this._kv.get<unknown>(sessionNameKey(name));
    return typeof entry.value === "string" ? entry.value : undefined;
  }

  async listHeaders(): Promise<SessionHeader[]> {
    const headers: SessionHeader[] = [];
    for await (const entry of this._kv.list<unknown>({ prefix: ["sessions", "header"] })) {
      const id = entry.key[2];
      if (typeof id === "string") headers.push(parseCatalogHeader(entry.value, id));
    }
    return headers.toSorted((a, b) => a.id.localeCompare(b.id));
  }
}

/**
 * Reads and appends `{workspace}/sessions/{id}.jsonl`.
 * @internal
 */
export class SessionStore {
  private readonly _dir: string;
  private readonly _catalog: DenoKvSessionCatalog | undefined;
  private _catalogSynced = false;

  /** @param sessionsDir Directory containing `{id}.jsonl` session files. */
  constructor(sessionsDir: string, kv?: Deno.Kv) {
    this._dir = sessionsDir;
    this._catalog = kv ? new DenoKvSessionCatalog(kv) : undefined;
  }

  /** Rebuilds the KV catalog from JSONL headers. JSONL remains the source of truth. */
  async syncCatalog(): Promise<void> {
    if (!this._catalog) return;
    const headers: SessionHeader[] = [];
    for (const id of await this.list()) {
      headers.push(await this.readHeader(id));
    }
    await this._catalog.rebuild(headers);
    this._catalogSynced = true;
  }

  /** Creates an empty v3 session log if it does not already exist. */
  async create(id: string, options?: { name?: string }): Promise<void> {
    assertValidSessionId(id);
    await this._ensureCatalogSynced();
    if (await this.exists(id)) return;
    const name = options?.name;
    if (name !== undefined) {
      assertValidSessionName(name);
      await this._assertNameAvailable(name);
    }
    const header: SessionHeader = {
      version: FORMAT_VERSION,
      id,
      createdAt: new Date().toISOString(),
      ...(name !== undefined ? { name } : {}),
    };
    await Deno.writeTextFile(this._path(id), `${serializeHeader(header)}\n`, { createNew: true });
    await this._catalog?.putHeader(header);
  }

  /** Appends one entry to an existing session log. */
  async append(id: string, entry: SessionEntry): Promise<void> {
    assertValidSessionId(id);
    await Deno.writeTextFile(this._path(id), `${JSON.stringify(entry)}\n`, { append: true });
  }

  /** Appends multiple entries in one write to an existing session log. */
  async appendMany(id: string, entries: SessionEntry[]): Promise<void> {
    assertValidSessionId(id);
    if (entries.length === 0) return;
    const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await Deno.writeTextFile(this._path(id), text, { append: true });
  }

  /** Reads the session JSONL header (line 1). */
  async readHeader(id: string): Promise<SessionHeader> {
    assertValidSessionId(id);
    const text = await Deno.readTextFile(this._path(id));
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
      text = await Deno.readTextFile(this._path(id));
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
    await this._ensureCatalogSynced();
    if (name !== undefined) {
      assertValidSessionName(name);
      await this._assertNameAvailable(name, id);
    }

    const log = await this.read(id);
    const previousName = log.header.name;
    const header: SessionHeader = {
      version: FORMAT_VERSION,
      id: log.header.id,
      createdAt: log.header.createdAt,
      ...(name !== undefined ? { name } : {}),
    };
    const lines = [serializeHeader(header), ...log.entries.map((entry) => JSON.stringify(entry))];
    const text = lines.join("\n") + "\n";
    const tempPath = `${this._path(id)}.tmp-${crypto.randomUUID()}`;
    try {
      await Deno.writeTextFile(tempPath, text);
      await Deno.rename(tempPath, this._path(id));
      await this._catalog?.putHeader(header, previousName);
    } catch (error) {
      await Deno.remove(tempPath).catch(() => undefined);
      throw error;
    }
  }

  /** Returns session ids with the given name, excluding one id when provided. */
  async findIdsByName(name: string, exceptId?: string): Promise<string[]> {
    await this._ensureCatalogSynced();
    if (this._catalog) {
      const id = await this._catalog.getIdByName(name);
      if (id && id !== exceptId) {
        try {
          const header = await this.readHeader(id);
          if (header.name === name) return [id];
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await this._catalog.deleteName(name);
      }
      const matches = await this._findIdsByNameFromDisk(name, exceptId);
      for (const match of matches) {
        await this._catalog.putHeader(await this.readHeader(match));
      }
      return matches;
    }
    return await this._findIdsByNameFromDisk(name, exceptId);
  }

  async _findIdsByNameFromDisk(name: string, exceptId?: string): Promise<string[]> {
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
    await this._ensureCatalogSynced();
    if (this._catalog) {
      const headers: SessionHeader[] = [];
      for (const header of await this._catalog.listHeaders()) {
        try {
          const diskHeader = await this.readHeader(header.id);
          headers.push(diskHeader);
          if (JSON.stringify(diskHeader) !== JSON.stringify(header)) {
            await this._catalog.putHeader(diskHeader, header.name);
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          await this._catalog.deleteHeader(header.id, header.name);
        }
      }
      return headers.toSorted((a, b) => a.id.localeCompare(b.id));
    }
    const headers: SessionHeader[] = [];
    for (const id of await this.list()) {
      headers.push(await this.readHeader(id));
    }
    return headers;
  }

  /** Lists session ids (filenames without `.jsonl`). */
  async list(): Promise<string[]> {
    const entries = await Array.fromAsync(Deno.readDir(this._dir));
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
      await Deno.stat(this._path(id));
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
      await Deno.stat(this._legacyPath(id));
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  async _assertNameAvailable(name: string, exceptId?: string): Promise<void> {
    const matches = await this.findIdsByName(name, exceptId);
    if (matches.length > 0) throw new Error("Session name already in use");
  }

  _path(id: string): string {
    return `${this._dir}/${id}.jsonl`;
  }

  _legacyPath(id: string): string {
    return `${this._dir}/${id}.json`;
  }

  async _ensureCatalogSynced(): Promise<void> {
    if (!this._catalog || this._catalogSynced) return;
    await this.syncCatalog();
  }
}
