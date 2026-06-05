import * as path from "@std/path";

import type { ApprovalGate, ApprovalOperation, ApprovalRequest } from "../shared/approval.ts";
import { approveDecision, denyDecision } from "../shared/approval.ts";
import type {
  PermissionCallbackDispatch,
  PermissionPromptPort,
  PermissionPromptRequest,
  PermissionPromptResult,
  PermissionPromptTurnTarget,
} from "../permission-broker/mod.ts";

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
  /** Built-in workspace-local tool policy. Missing legacy values use `workspace-readonly`. */
  localToolPolicy?: CronLocalToolPolicy;
  /** App/model tool approvals that can be answered without Telegram prompts. */
  toolRules: CronPermissionToolRule[];
  /** Runtime broker permissions that can be answered without Telegram prompts. */
  brokerRules: CronPermissionBrokerRule[];
}

/** Permission prompt port with a cron-profile execution scope. */
export interface CronPermissionPromptPort extends PermissionPromptPort {
  /** Runs `operation` while broker prompts are answered from `profile`. */
  withProfile<T>(
    profile: CronPermissionProfile,
    jobId: string,
    operation: () => Promise<T>,
    options?: {
      onApprovedBrokerRule?: (rule: CronPermissionBrokerRule) => void | Promise<void>;
    },
  ): Promise<T>;
}

function matchesToolRule(profile: CronPermissionProfile, request: ApprovalRequest): boolean {
  return profile.toolRules.some((rule) =>
    matchesExactToolRule(rule, request) || matchesMutationToolRule(rule, request)
  );
}

function matchesBrokerRule(profile: CronPermissionProfile, request: PermissionPromptRequest): boolean {
  return profile.brokerRules.some((rule) => rule.permission === request.permission && rule.value === request.value);
}

const workspaceReadOnlyOperations = new Set<ApprovalOperation>(["read", "list", "find", "grep", "skill"]);
const localMutationOperations = new Set<ApprovalOperation>(["write", "edit"]);

function matchesExactToolRule(rule: CronPermissionToolRule, request: ApprovalRequest): boolean {
  return rule.operation === request.operation && rule.target === request.target;
}

function isWorkspaceDisplayTarget(target: string): boolean {
  return !path.isAbsolute(target) && !target.startsWith("~");
}

function matchesMutationToolRule(rule: CronPermissionToolRule, request: ApprovalRequest): boolean {
  return rule.target === request.target &&
    localMutationOperations.has(rule.operation) &&
    localMutationOperations.has(request.operation);
}

function matchesLocalToolPolicy(profile: CronPermissionProfile, request: ApprovalRequest): boolean {
  const policy = profile.localToolPolicy ?? "workspace-readonly";
  return policy === "workspace-readonly" &&
    request.risk === "low" &&
    workspaceReadOnlyOperations.has(request.operation) &&
    isWorkspaceDisplayTarget(request.target);
}

/** Creates an approval gate that auto-allows preapproved cron operations and delegates the rest. */
export function createCronApprovalGate(
  profile: CronPermissionProfile,
  jobId: string,
  fallback?: ApprovalGate,
  onApprovedToolRule?: (rule: CronPermissionToolRule) => void | Promise<void>,
): ApprovalGate {
  return {
    isPending: () => fallback?.isPending?.() ?? false,
    requestApproval: async (request, signal) => {
      if (matchesToolRule(profile, request) || matchesLocalToolPolicy(profile, request)) {
        return approveDecision(`cron:${jobId}`);
      }
      if (!fallback) return denyDecision("cron_permission_not_preapproved", `cron:${jobId}`);
      const decision = await fallback.requestApproval(request, signal);
      if (decision.approved) {
        await onApprovedToolRule?.({ operation: request.operation, target: request.target });
      }
      return decision;
    },
  };
}

/** Wraps the interactive permission prompt port with cron-profile auto decisions. */
export function createCronPermissionPromptPort(base: PermissionPromptPort): CronPermissionPromptPort {
  const stack: {
    profile: CronPermissionProfile;
    jobId: string;
    onApprovedBrokerRule?: (rule: CronPermissionBrokerRule) => void | Promise<void>;
  }[] = [];

  function active(): typeof stack[number] | undefined {
    return stack.at(-1);
  }

  return {
    isPending: () => base.isPending(),
    setTurnContext(target: PermissionPromptTurnTarget): void {
      base.setTurnContext(target);
    },
    clearTurnContext(): void {
      base.clearTurnContext();
    },
    abortPending(): void {
      base.abortPending();
    },
    handleCallback(
      data: string,
      actorId: number | undefined,
      adminId: number,
    ): Promise<PermissionCallbackDispatch> {
      return base.handleCallback(data, actorId, adminId);
    },
    async prompt(request: PermissionPromptRequest, signal?: AbortSignal): Promise<PermissionPromptResult> {
      const current = active();
      if (!current) return base.prompt(request, signal);
      if (matchesBrokerRule(current.profile, request)) return { result: "allow", grant: "once" };
      const result = await base.prompt(request, signal);
      if (result.result === "allow") {
        await current.onApprovedBrokerRule?.({ permission: request.permission, value: request.value });
      }
      return result;
    },
    async withProfile<T>(
      profile: CronPermissionProfile,
      jobId: string,
      operation: () => Promise<T>,
      options?: {
        onApprovedBrokerRule?: (rule: CronPermissionBrokerRule) => void | Promise<void>;
      },
    ): Promise<T> {
      stack.push({ profile, jobId, onApprovedBrokerRule: options?.onApprovedBrokerRule });
      try {
        return await operation();
      } finally {
        stack.pop();
      }
    },
  };
}
