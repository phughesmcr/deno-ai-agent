/** Durable v4 session format version. */
export const SESSION_VERSION = 4 as const;

/** Durable v4 session metadata. */
export interface SessionRecord {
  /** Session identifier. */
  id: string;
  /** Durable session format version. */
  version: typeof SESSION_VERSION;
  /** ISO timestamp when the session was created. */
  createdAt: string;
  /** ISO timestamp when the session metadata was last updated. */
  updatedAt: string;
  /** Optional user-facing alias. */
  name?: string;
  /** Parent session id when this record was forked. */
  parentSessionId?: string;
}

/** Input for creating a v4 session record. */
export interface CreateSessionInput {
  /** Optional caller-owned id. */
  id?: string;
  /** Optional user-facing alias. */
  name?: string;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Options for renaming a session. */
export interface RenameSessionOptions {
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Options for forking a session metadata record. */
export interface ForkSessionOptions extends CreateSessionInput {
  /** Optional fork name. */
  name?: string;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const SESSION_BY_ID_PREFIX: Deno.KvKey = ["core", "sessions", "by-id"];
const SESSION_BY_NAME_PREFIX: Deno.KvKey = ["core", "sessions", "by-name"];

function sessionByIdKey(id: string): Deno.KvKey {
  return [...SESSION_BY_ID_PREFIX, id];
}

function sessionByNameKey(name: string): Deno.KvKey {
  return [...SESSION_BY_NAME_PREFIX, name];
}

function iso(date: Date): string {
  return date.toISOString();
}

function assertValidSessionId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) throw new Error("Invalid session id");
}

function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

function assertValidSessionName(name: string): void {
  if (!SESSION_NAME_PATTERN.test(name) || isValidSessionId(name)) throw new Error("Invalid session name");
}

/** KV-backed source of truth for durable v4 session metadata. */
export class KvSessionCatalog {
  private readonly _kv: Deno.Kv;

  /** Creates a session catalog. */
  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  /** Creates a new durable v4 session record. */
  async create(input: CreateSessionInput = {}): Promise<SessionRecord> {
    const id = input.id ?? crypto.randomUUID();
    assertValidSessionId(id);
    if (input.name !== undefined) assertValidSessionName(input.name);
    const now = iso(input.now ?? new Date());
    const record: SessionRecord = {
      id,
      version: SESSION_VERSION,
      createdAt: now,
      updatedAt: now,
      ...(input.name !== undefined ? { name: input.name } : {}),
    };
    await this._insert(record);
    return record;
  }

  /** Creates a fork metadata record linked to an existing parent session. */
  async fork(parentSessionId: string, options: ForkSessionOptions = {}): Promise<SessionRecord> {
    const parent = await this.get(parentSessionId);
    if (!parent) throw new Error(`No v4 session with id "${parentSessionId}"`);
    const id = options.id ?? crypto.randomUUID();
    assertValidSessionId(id);
    if (options.name !== undefined) assertValidSessionName(options.name);
    const now = iso(options.now ?? new Date());
    const record: SessionRecord = {
      id,
      version: SESSION_VERSION,
      createdAt: now,
      updatedAt: now,
      parentSessionId,
      ...(options.name !== undefined ? { name: options.name } : {}),
    };
    await this._insert(record);
    return record;
  }

  /** Gets a session by id. */
  async get(id: string): Promise<SessionRecord | null> {
    assertValidSessionId(id);
    return (await this._kv.get<SessionRecord>(sessionByIdKey(id))).value ?? null;
  }

  /** Resolves a v4 session by id or name. */
  async resolve(ref: string): Promise<SessionRecord> {
    if (isValidSessionId(ref)) {
      const record = await this.get(ref);
      if (!record) throw new Error(`No v4 session with id "${ref}"`);
      return record;
    }
    const id = await this._idForName(ref);
    if (!id) throw new Error(`No v4 session named "${ref}"`);
    const record = await this.get(id);
    if (!record || record.name !== ref) {
      await this._kv.delete(sessionByNameKey(ref));
      throw new Error(`No v4 session named "${ref}"`);
    }
    return record;
  }

  /** Lists v4 sessions sorted by id. */
  async list(): Promise<SessionRecord[]> {
    const records: SessionRecord[] = [];
    for await (const entry of this._kv.list<SessionRecord>({ prefix: SESSION_BY_ID_PREFIX })) {
      records.push(entry.value);
    }
    return records.toSorted((left, right) => left.id.localeCompare(right.id));
  }

  /** Renames a session and updates the name index. */
  async rename(id: string, name: string | undefined, options: RenameSessionOptions = {}): Promise<SessionRecord> {
    assertValidSessionId(id);
    if (name !== undefined) assertValidSessionName(name);
    while (true) {
      const recordEntry = await this._kv.get<SessionRecord>(sessionByIdKey(id));
      const current = recordEntry.value;
      if (!current) throw new Error(`No v4 session with id "${id}"`);
      if (name !== undefined) {
        const nameOwner = await this._idForName(name);
        if (nameOwner && nameOwner !== id) throw new Error("Session name already in use");
      }
      const updated: SessionRecord = {
        ...current,
        updatedAt: iso(options.now ?? new Date()),
        ...(name !== undefined ? { name } : {}),
      };
      if (name === undefined) {
        const { name: _name, ...withoutName } = updated;
        const unnamed: SessionRecord = withoutName;
        let atomic = this._kv.atomic().check(recordEntry).set(sessionByIdKey(id), unnamed);
        if (current.name !== undefined) atomic = atomic.delete(sessionByNameKey(current.name));
        const result = await atomic.commit();
        if (result.ok) return unnamed;
        continue;
      }

      const nameEntry = await this._kv.get<string>(sessionByNameKey(name));
      if (nameEntry.value && nameEntry.value !== id) throw new Error("Session name already in use");
      let atomic = this._kv.atomic()
        .check(recordEntry)
        .check(nameEntry)
        .set(sessionByIdKey(id), updated)
        .set(sessionByNameKey(name), id);
      if (current.name !== undefined && current.name !== name) atomic = atomic.delete(sessionByNameKey(current.name));
      const result = await atomic.commit();
      if (result.ok) return updated;
    }
  }

  /** Inserts a new session record and optional name index. */
  async _insert(record: SessionRecord): Promise<void> {
    while (true) {
      const recordEntry = await this._kv.get<SessionRecord>(sessionByIdKey(record.id));
      if (recordEntry.value) throw new Error("Session already exists");
      const nameEntry = record.name !== undefined ? await this._kv.get<string>(sessionByNameKey(record.name)) : null;
      if (nameEntry?.value) throw new Error("Session name already in use");

      let atomic = this._kv.atomic().check(recordEntry).set(sessionByIdKey(record.id), record);
      if (record.name !== undefined && nameEntry) {
        atomic = atomic.check(nameEntry).set(sessionByNameKey(record.name), record.id);
      }
      const result = await atomic.commit();
      if (result.ok) return;
    }
  }

  /** Looks up a session id by name. */
  async _idForName(name: string): Promise<string | null> {
    const entry = await this._kv.get<string>(sessionByNameKey(name));
    return entry.value ?? null;
  }
}
