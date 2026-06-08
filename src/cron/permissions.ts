import * as path from "@std/path";

import type { CapabilityDecisionDelegate, CapabilityDelegateDecision, CapabilityRequest } from "../core/mod.ts";
import type { ApprovalOperation } from "../shared/approval.ts";

/** Exact app-layer tool approval allowed for a cron job. */
export interface CronPermissionToolRule {
  /** Operation category from the app approval layer. */
  operation: ApprovalOperation;
  /** Exact approval target, such as `gmail/search`. */
  target: string;
}

/** Exact Deno permission broker grant allowed for a cron job. */
export interface CronPermissionBrokerRule {
  /** Deno permission kind, such as `net`, `read`, `write`, or `run`. */
  permission: string;
  /** Exact broker value. `null` matches value-less permission requests. */
  value: string | null;
}

/** Built-in local tool policy for background cron runs. */
export type CronLocalToolPolicy = "none" | "workspace-readonly";

/** Explicit background permission profile for one cron job. */
export interface CronPermissionProfile {
  /** Built-in workspace-local tool policy. Defaults to `workspace-readonly`. */
  localToolPolicy?: CronLocalToolPolicy;
  /** App/model tool approvals that can be answered without Telegram prompts. */
  toolRules: CronPermissionToolRule[];
  /** Runtime broker permissions that can be answered without Telegram prompts. */
  brokerRules: CronPermissionBrokerRule[];
}

/** Hooks for persisting cron-profile rules learned through fallback prompts. */
export interface CronCapabilityProfileHooks {
  /** Called when a fallback prompt approves an app/model tool capability. */
  onApprovedToolRule?: (rule: CronPermissionToolRule) => void | Promise<void>;
  /** Called when a fallback prompt approves a broker permission capability. */
  onApprovedBrokerRule?: (rule: CronPermissionBrokerRule) => void | Promise<void>;
}

/** Capability delegate with an active cron-profile stack. */
export interface CronCapabilityDelegate extends CapabilityDecisionDelegate {
  /** Runs `operation` while capability prompts are answered from `profile` when possible. */
  withProfile<T>(
    profile: CronPermissionProfile,
    jobId: string,
    operation: () => Promise<T>,
    hooks?: CronCapabilityProfileHooks,
  ): Promise<T>;
}

const workspaceReadOnlyOperations = new Set<ApprovalOperation>(["read", "list", "find", "grep", "skill"]);
const localMutationOperations = new Set<ApprovalOperation>(["write", "edit"]);
const approvalOperations = new Set<ApprovalOperation>([
  "read",
  "write",
  "edit",
  "list",
  "find",
  "grep",
  "skill",
  "todo",
  "session",
  "shell",
  "network",
  "mcp",
]);

function isApprovalOperation(value: string): value is ApprovalOperation {
  return approvalOperations.has(value as ApprovalOperation);
}

function isWorkspaceDisplayTarget(target: string): boolean {
  return !path.isAbsolute(target) && !target.startsWith("~");
}

function toolRuleForCapability(request: CapabilityRequest): CronPermissionToolRule | undefined {
  if (request.source === "mcp_tool") {
    return { operation: "mcp", target: request.capability.target };
  }
  if (request.source !== "local_tool") return undefined;
  if (!isApprovalOperation(request.capability.action)) return undefined;
  return { operation: request.capability.action, target: request.capability.target };
}

function brokerRuleForCapability(request: CapabilityRequest): CronPermissionBrokerRule | undefined {
  if (request.source !== "broker_permission") return undefined;
  return {
    permission: request.capability.action,
    value: request.capability.target === "(none)" ? null : request.capability.target,
  };
}

function matchesExactToolRule(rule: CronPermissionToolRule, request: CronPermissionToolRule): boolean {
  return rule.operation === request.operation && rule.target === request.target;
}

function matchesMutationToolRule(rule: CronPermissionToolRule, request: CronPermissionToolRule): boolean {
  return rule.target === request.target &&
    localMutationOperations.has(rule.operation) &&
    localMutationOperations.has(request.operation);
}

function matchesToolRule(profile: CronPermissionProfile, request: CapabilityRequest): boolean {
  const rule = toolRuleForCapability(request);
  if (!rule) return false;
  return profile.toolRules.some((candidate) =>
    matchesExactToolRule(candidate, rule) || matchesMutationToolRule(candidate, rule)
  );
}

function matchesBrokerRule(profile: CronPermissionProfile, request: CapabilityRequest): boolean {
  const rule = brokerRuleForCapability(request);
  if (!rule) return false;
  return profile.brokerRules.some((candidate) =>
    candidate.permission === rule.permission && candidate.value === rule.value
  );
}

function matchesLocalToolPolicy(profile: CronPermissionProfile, request: CapabilityRequest): boolean {
  const policy = profile.localToolPolicy ?? "workspace-readonly";
  return policy === "workspace-readonly" &&
    request.source === "local_tool" &&
    request.risk === "low" &&
    workspaceReadOnlyOperations.has(request.capability.action as ApprovalOperation) &&
    isWorkspaceDisplayTarget(request.capability.target);
}

function policyAllow(jobId: string): CapabilityDelegateDecision {
  return {
    decision: "allow",
    scope: "once",
    reason: "approved",
    decidedAt: new Date().toISOString(),
    decidedBy: `cron:${jobId}`,
    source: "policy",
  };
}

async function maybeCacheApprovedRule(
  request: CapabilityRequest,
  decision: CapabilityDelegateDecision,
  hooks?: CronCapabilityProfileHooks,
): Promise<void> {
  if (decision.decision !== "allow") return;
  const toolRule = toolRuleForCapability(request);
  if (toolRule) {
    await hooks?.onApprovedToolRule?.(toolRule);
    return;
  }
  const brokerRule = brokerRuleForCapability(request);
  if (brokerRule) await hooks?.onApprovedBrokerRule?.(brokerRule);
}

/** Creates a cron-profile capability delegate over an interactive fallback delegate. */
export function createCronCapabilityDelegate(base: CapabilityDecisionDelegate): CronCapabilityDelegate {
  const stack: {
    profile: CronPermissionProfile;
    jobId: string;
    hooks?: CronCapabilityProfileHooks;
  }[] = [];

  function active(): typeof stack[number] | undefined {
    return stack.at(-1);
  }

  return {
    async decide(request: CapabilityRequest, signal?: AbortSignal): Promise<CapabilityDelegateDecision> {
      const current = active();
      if (!current) return await base.decide(request, signal);

      if (
        matchesToolRule(current.profile, request) ||
        matchesLocalToolPolicy(current.profile, request) ||
        matchesBrokerRule(current.profile, request)
      ) {
        return policyAllow(current.jobId);
      }

      const decision = await base.decide(request, signal);
      await maybeCacheApprovedRule(request, decision, current.hooks);
      return decision;
    },
    async withProfile<T>(
      profile: CronPermissionProfile,
      jobId: string,
      operation: () => Promise<T>,
      hooks?: CronCapabilityProfileHooks,
    ): Promise<T> {
      stack.push({ profile, jobId, hooks });
      try {
        return await operation();
      } finally {
        stack.pop();
      }
    },
  };
}
