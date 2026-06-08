import type {
  CapabilityDecision,
  CapabilityDescriptor,
  CapabilityLedger,
  CapabilityRequestSource,
  CapabilityScope,
} from "./capability_ledger.ts";
import type { DurableEvent, EventStore } from "./events.ts";

/** Coarse risk label shown to the approving user. */
export type CapabilityRisk = "low" | "medium" | "high";

/** User-facing rendering data for a capability prompt. */
export interface CapabilityRequestDisplay {
  /** Short action label, such as `write`, `call`, or `run`. */
  action: string;
  /** Human-readable target label. */
  target: string;
  /** Optional short subject, such as a tool name. */
  subject?: string;
}

/** One capability decision request for a turn-scoped privileged action. */
export interface CapabilityRequest {
  /** Stable request id used for durable events and UI callbacks. */
  id: string;
  /** Session this request belongs to. */
  sessionId: string;
  /** Work item this request belongs to, when known. */
  workId?: string;
  /** Capability key being requested. */
  capability: CapabilityDescriptor;
  /** Adapter source for the request. */
  source: CapabilityRequestSource;
  /** Coarse user-facing risk. */
  risk: CapabilityRisk;
  /** Short operation summary that avoids file contents and secrets. */
  summary?: string;
  /** Deny automatically after this many milliseconds. */
  timeoutMs: number;
  /** Display metadata for prompt adapters. */
  display: CapabilityRequestDisplay;
}

/** Prompt or policy decision for a capability request. */
export interface CapabilityPromptDecision {
  /** Whether the request is allowed or denied. */
  decision: CapabilityDecision;
  /** Decision scope. */
  scope: CapabilityScope;
  /** Machine-readable reason. */
  reason: string;
  /** ISO timestamp when the decision was made. */
  decidedAt: string;
  /** Actor or policy source that made the decision. */
  decidedBy?: string;
}

/** Decision returned to an authorization caller. */
export interface CapabilityDecisionResult {
  /** True only when the capability is allowed. */
  allowed: boolean;
  /** Machine-readable reason. */
  reason: string;
  /** Decision scope. */
  scope: CapabilityScope;
  /** Source of the effective decision. */
  source: "ledger" | "prompt" | "policy";
  /** Broker-compatible grant scope for allowed decisions. */
  grant?: "once" | "session";
}

/** Prompt/policy delegate result with an optional source override. */
export type CapabilityDelegateDecision = CapabilityPromptDecision & {
  /** Defaults to `prompt` when omitted. */
  source?: "prompt" | "policy";
};

/** Prompt or policy boundary for unresolved capability requests. */
export interface CapabilityDecisionDelegate {
  /** Resolves an unresolved capability request, usually by prompting a user or applying policy. */
  decide(request: CapabilityRequest, signal?: AbortSignal): Promise<CapabilityDelegateDecision>;
}

/** A requested capability that has no matching durable decision event. */
export interface PendingCapability<TRequest = CapabilityRequest> {
  /** Stable replay key derived from work/session/capability. */
  key: string;
  /** Capability being approved. */
  capability: CapabilityDescriptor;
  /** Work item associated with the request, when any. */
  workId?: string;
  /** Session associated with the request, when any. */
  sessionId?: string;
  /** Original capability request payload, when available. */
  request?: TRequest;
  /** Durable request event sequence. */
  requestedSequence: number;
}

/** Filters for replaying pending capabilities. */
export interface PendingCapabilityListOptions {
  /** Restrict replay to one work item. */
  workId?: string;
  /** Restrict replay to one session. */
  sessionId?: string;
}

/** Options for the core capability decision service. */
export interface CapabilityDecisionServiceOptions {
  /** Durable capability ledger. */
  ledger: CapabilityLedger;
  /** Durable event store. */
  events: EventStore;
}

function objectPayload(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  return payload as Record<string, unknown>;
}

function capabilityFromPayload(payload: unknown): CapabilityDescriptor | undefined {
  const capability = objectPayload(payload)?.["capability"];
  if (capability === null || typeof capability !== "object") return undefined;
  const record = capability as Record<string, unknown>;
  if (
    typeof record["kind"] !== "string" ||
    typeof record["target"] !== "string" ||
    typeof record["action"] !== "string"
  ) {
    return undefined;
  }
  return {
    kind: record["kind"] as CapabilityDescriptor["kind"],
    target: record["target"],
    action: record["action"],
  };
}

function capabilityKey(capability: CapabilityDescriptor): string {
  return JSON.stringify([capability.kind, capability.target, capability.action]);
}

function pendingCapabilityKey(
  event: { workId?: string; sessionId?: string },
  capability: CapabilityDescriptor,
): string {
  return JSON.stringify([event.workId ?? "", event.sessionId ?? "", capabilityKey(capability)]);
}

async function listCapabilityEvents(
  events: EventStore,
  options?: PendingCapabilityListOptions,
): Promise<DurableEvent[]> {
  if (options?.workId !== undefined) return await events.listByWork(options.workId);
  if (options?.sessionId !== undefined) return await events.listBySession(options.sessionId);
  return await events.list();
}

function grantForAllowedScope(scope: CapabilityScope): "once" | "session" | undefined {
  if (scope === "once" || scope === "session") return scope;
  return undefined;
}

/** Core capability decision model for tools, MCP, broker prompts, and cron profiles. */
export class CapabilityDecisionService {
  private readonly _ledger: CapabilityLedger;
  private readonly _events: EventStore;

  /** Creates the decision service. */
  constructor(options: CapabilityDecisionServiceOptions) {
    this._ledger = options.ledger;
    this._events = options.events;
  }

  /** Resolves one capability request through durable grants, then a prompt/policy delegate. */
  async decide(
    request: CapabilityRequest,
    delegate: CapabilityDecisionDelegate,
    signal?: AbortSignal,
  ): Promise<CapabilityDecisionResult> {
    await this._events.append({
      category: "approval.requested",
      workId: request.workId,
      sessionId: request.sessionId,
      payload: {
        capability: request.capability,
        request,
      },
    });

    const authorization = await this._ledger.authorize({
      sessionId: request.sessionId,
      capability: request.capability,
    });
    if (authorization.state !== "unresolved") {
      await this._events.append({
        category: "approval.decided",
        workId: request.workId,
        sessionId: request.sessionId,
        payload: {
          capability: authorization.record.capability,
          decision: authorization.state === "allowed" ? "allow" : "deny",
          scope: authorization.record.scope,
          reason: authorization.record.reason,
          source: "ledger",
        },
      });
      return {
        allowed: authorization.state === "allowed",
        reason: authorization.record.reason,
        scope: authorization.record.scope,
        source: "ledger",
        ...(authorization.state === "allowed" ? { grant: grantForAllowedScope(authorization.record.scope) } : {}),
      };
    }

    const decision = await delegate.decide(request, signal);
    const source = decision.source ?? "prompt";
    await this._ledger.recordDecision({
      workId: request.workId,
      sessionId: request.sessionId,
      capability: request.capability,
      decision: decision.decision,
      scope: decision.scope,
      reason: decision.reason,
      consumeImmediately: decision.scope === "once",
      ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
      source,
      now: new Date(decision.decidedAt),
    });
    return {
      allowed: decision.decision === "allow",
      reason: decision.reason,
      scope: decision.scope,
      source,
      ...(decision.decision === "allow" ? { grant: grantForAllowedScope(decision.scope) } : {}),
    };
  }
}

/** Replays durable events and returns capability requests with no matching decision. */
export async function listPendingCapabilities<TRequest = CapabilityRequest>(
  events: EventStore,
  options?: PendingCapabilityListOptions,
): Promise<PendingCapability<TRequest>[]> {
  const pending = new Map<string, PendingCapability<TRequest>>();

  for (const event of await listCapabilityEvents(events, options)) {
    if (event.category !== "approval.requested" && event.category !== "approval.decided") continue;
    const capability = capabilityFromPayload(event.payload);
    if (!capability) continue;
    const key = pendingCapabilityKey(event, capability);

    if (event.category === "approval.requested") {
      const payload = objectPayload(event.payload);
      pending.set(key, {
        key,
        capability,
        ...(event.workId !== undefined ? { workId: event.workId } : {}),
        ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
        ...(payload?.["request"] !== undefined ? { request: payload["request"] as TRequest } : {}),
        requestedSequence: event.sequence,
      });
    } else {
      pending.delete(key);
    }
  }

  return [...pending.values()].sort((left, right) => left.requestedSequence - right.requestedSequence);
}
