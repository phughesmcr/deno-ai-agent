import { type EventStore, isKvEventMutationStore, type KvEventMutationStore } from "./events.ts";

/** Capability families recorded in the authorization ledger. */
export type CapabilityRequestSource =
  | "local_tool"
  | "mcp_tool"
  | "broker_permission"
  | "cron_profile";

/** Capability families recorded in the authorization ledger. */
export type CapabilityKind = CapabilityRequestSource;

/** Durable authorization scope. */
export type CapabilityScope = "once" | "session" | "profile";

/** Authorization decision. */
export type CapabilityDecision = "allow" | "deny";

/** Capability descriptor used as the stable authorization key. */
export interface CapabilityDescriptor {
  /** Capability family. */
  kind: CapabilityKind;
  /** Tool, permission, or profile target. */
  target: string;
  /** Requested action. */
  action: string;
}

/** Records a user, profile, or policy decision. */
export interface RecordCapabilityDecisionInput {
  /** Work item this decision belongs to, when known. */
  workId?: string;
  /** Session this decision applies to. */
  sessionId: string;
  /** Capability being decided. */
  capability: CapabilityDescriptor;
  /** Allow or deny. */
  decision: CapabilityDecision;
  /** Decision scope. */
  scope: CapabilityScope;
  /** Human or policy reason. */
  reason: string;
  /** Optional expiry. */
  expiresAt?: Date;
  /** Marks a one-shot decision as already spent by the current request. */
  consumeImmediately?: boolean;
  /** Actor or policy source that made the decision. */
  decidedBy?: string;
  /** Decision source recorded in durable approval events. */
  source?: "prompt" | "policy";
  /** Optional timestamp, mostly for deterministic tests. */
  now?: Date;
}

/** Capability authorization request. */
export interface CapabilityAuthorizationRequest {
  /** Session this request belongs to. */
  sessionId: string;
  /** Capability being requested. */
  capability: CapabilityDescriptor;
  /** Current time, mostly for deterministic tests. */
  now?: Date;
}

/** Stored capability decision. */
export interface CapabilityDecisionRecord {
  /** Stable decision id. */
  id: string;
  /** Session this decision applies to. */
  sessionId: string;
  /** Capability being decided. */
  capability: CapabilityDescriptor;
  /** Allow or deny. */
  decision: CapabilityDecision;
  /** Decision scope. */
  scope: CapabilityScope;
  /** Human or policy reason. */
  reason: string;
  /** ISO timestamp when created. */
  createdAt: string;
  /** Optional ISO expiry. */
  expiresAt?: string;
  /** ISO timestamp when a once grant was consumed. */
  consumedAt?: string;
  /** Actor or policy source that made the decision. */
  decidedBy?: string;
}

/** Capability authorization result. */
export type CapabilityAuthorizationResult =
  | { state: "allowed"; record: CapabilityDecisionRecord }
  | { state: "denied"; record: CapabilityDecisionRecord }
  | { state: "unresolved" };

const DECISION_PREFIX: Deno.KvKey = ["core", "capabilities", "decision"];
const ACTIVE_PREFIX: Deno.KvKey = ["core", "capabilities", "active"];

function iso(date: Date): string {
  return date.toISOString();
}

function decisionKey(id: string): Deno.KvKey {
  return [...DECISION_PREFIX, id];
}

function capabilityFingerprint(capability: CapabilityDescriptor): string {
  return JSON.stringify([capability.kind, capability.target, capability.action]);
}

function activeKey(record: CapabilityDecisionRecord): Deno.KvKey {
  return [...ACTIVE_PREFIX, record.sessionId, capabilityFingerprint(record.capability), record.id];
}

function activePrefix(sessionId: string, capability: CapabilityDescriptor): Deno.KvKey {
  return [...ACTIVE_PREFIX, sessionId, capabilityFingerprint(capability)];
}

function isExpired(record: CapabilityDecisionRecord, now: Date): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime();
}

/** Durable capability ledger backed by Deno KV. */
export class CapabilityLedger {
  private readonly _kv: Deno.Kv;
  private readonly _events: KvEventMutationStore;

  /** Creates a capability ledger. */
  constructor(options: { kv: Deno.Kv; events: EventStore }) {
    if (!isKvEventMutationStore(options.events)) {
      throw new Error("CapabilityLedger requires a KV kernel event store");
    }
    this._kv = options.kv;
    this._events = options.events;
  }

  /** Records an authorization decision and emits an approval event. */
  async recordDecision(input: RecordCapabilityDecisionInput): Promise<CapabilityDecisionRecord> {
    const now = input.now ?? new Date();
    const record: CapabilityDecisionRecord = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      capability: input.capability,
      decision: input.decision,
      scope: input.scope,
      reason: input.reason,
      createdAt: iso(now),
      ...(input.expiresAt !== undefined ? { expiresAt: iso(input.expiresAt) } : {}),
      ...(input.consumeImmediately ? { consumedAt: iso(now) } : {}),
      ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
    };
    await this._events.commitKvMutationWithEvents(
      (atomic) => {
        let next = atomic.set(decisionKey(record.id), record);
        if (!input.consumeImmediately) next = next.set(activeKey(record), record);
        return next;
      },
      [{
        category: "approval.decided",
        workId: input.workId,
        sessionId: input.sessionId,
        payload: {
          capability: input.capability,
          decision: input.decision,
          scope: input.scope,
          reason: input.reason,
          source: input.source ?? "prompt",
          ...(input.consumeImmediately ? { consumed: true } : {}),
          ...(input.decidedBy !== undefined ? { decidedBy: input.decidedBy } : {}),
        },
      }],
    );
    return record;
  }

  /** Resolves a capability request, consuming once-scoped grants. */
  async authorize(request: CapabilityAuthorizationRequest): Promise<CapabilityAuthorizationResult> {
    const now = request.now ?? new Date();
    const records = await this._activeRecords(request.sessionId, request.capability, now);
    const record = records[0];
    if (!record) return { state: "unresolved" };
    if (record.decision === "deny") return { state: "denied", record };
    if (record.scope !== "once") return { state: "allowed", record };
    const consumed = await this._consumeOnce(record, now);
    if (!consumed) return await this.authorize(request);
    return { state: "allowed", record: consumed };
  }

  /** Returns active decisions for a session capability. */
  private async _activeRecords(
    sessionId: string,
    capability: CapabilityDescriptor,
    now: Date,
  ): Promise<CapabilityDecisionRecord[]> {
    const records: CapabilityDecisionRecord[] = [];
    for await (
      const entry of this._kv.list<CapabilityDecisionRecord>({ prefix: activePrefix(sessionId, capability) })
    ) {
      if (entry.value.consumedAt !== undefined || isExpired(entry.value, now)) {
        await this._kv.delete(entry.key);
        continue;
      }
      records.push(entry.value);
    }
    records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return records;
  }

  /** Consumes a once-scoped decision if it is still available. */
  private async _consumeOnce(record: CapabilityDecisionRecord, now: Date): Promise<CapabilityDecisionRecord | null> {
    const primaryEntry = await this._kv.get<CapabilityDecisionRecord>(decisionKey(record.id));
    const current = primaryEntry.value;
    if (!current || current.consumedAt !== undefined) return null;
    const consumed: CapabilityDecisionRecord = {
      ...current,
      consumedAt: iso(now),
    };
    const result = await this._kv.atomic()
      .check(primaryEntry)
      .set(decisionKey(record.id), consumed)
      .delete(activeKey(record))
      .commit();
    return result.ok ? consumed : null;
  }
}
