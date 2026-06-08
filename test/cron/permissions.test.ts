import { assertEquals } from "jsr:@std/assert@1";

import { createCronCapabilityDelegate, type CronPermissionProfile } from "../../src/cron/permissions.ts";
import type { CapabilityDecisionDelegate, CapabilityDelegateDecision, CapabilityRequest } from "../../src/core/mod.ts";

const profile: CronPermissionProfile = {
  toolRules: [
    { operation: "mcp", target: "gmail/search" },
    { operation: "mcp", target: "gmail/read" },
  ],
  brokerRules: [
    { permission: "net", value: "gmail.googleapis.com:443" },
  ],
};

function request(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    id: "capability-1",
    sessionId: "session",
    workId: "turn",
    source: "mcp_tool",
    capability: { kind: "mcp_tool", target: "gmail/search", action: "call" },
    risk: "high",
    timeoutMs: 1_000,
    display: {
      action: "call",
      target: "gmail/search",
    },
    ...overrides,
  };
}

function baseDelegate(decision: Partial<CapabilityDelegateDecision> = {}): CapabilityDecisionDelegate & {
  requests: CapabilityRequest[];
} {
  const requests: CapabilityRequest[] = [];
  return {
    requests,
    decide(capabilityRequest): Promise<CapabilityDelegateDecision> {
      requests.push(capabilityRequest);
      return Promise.resolve({
        decision: "deny",
        scope: "once",
        reason: "cron_permission_not_preapproved",
        decidedAt: "2026-06-08T09:00:00.000Z",
        decidedBy: "telegram",
        ...decision,
      });
    },
  };
}

Deno.test("cron capability delegate allows exact pre-approved MCP targets", async () => {
  const delegate = createCronCapabilityDelegate(baseDelegate());

  const decision = await delegate.withProfile(profile, "cron-job-1", () => delegate.decide(request()));

  assertEquals(decision.decision, "allow");
  assertEquals(decision.scope, "once");
  assertEquals(decision.reason, "approved");
  assertEquals(decision.decidedBy, "cron:cron-job-1");
  assertEquals(decision.source, "policy");
});

Deno.test("cron capability delegate delegates unknown tool targets to fallback", async () => {
  const base = baseDelegate({ decision: "allow", reason: "approved" });
  const cachedRules: { operation: string; target: string }[] = [];
  const delegate = createCronCapabilityDelegate(base);

  const decision = await delegate.withProfile(profile, "cron-job-1", () =>
    delegate.decide(request({
      capability: { kind: "mcp_tool", target: "gmail/delete", action: "call" },
      display: { action: "call", target: "gmail/delete" },
    })), {
    onApprovedToolRule: (rule) => {
      cachedRules.push(rule);
    },
  });

  assertEquals(decision.decision, "allow");
  assertEquals(decision.decidedBy, "telegram");
  assertEquals(base.requests.map((item) => item.capability.target), ["gmail/delete"]);
  assertEquals(cachedRules, [{ operation: "mcp", target: "gmail/delete" }]);
});

Deno.test("cron capability delegate treats same-target write and edit approvals as equivalent", async () => {
  const delegate = createCronCapabilityDelegate(baseDelegate());
  const cronProfile = {
    toolRules: [{ operation: "write" as const, target: "MEMORY.md" }],
    brokerRules: [],
  };

  const sameTarget = await delegate.withProfile(cronProfile, "cron-job-1", () =>
    delegate.decide(request({
      source: "local_tool",
      capability: { kind: "local_tool", target: "MEMORY.md", action: "edit" },
      risk: "medium",
      display: { action: "edit", target: "MEMORY.md" },
    })));
  const differentTarget = await delegate.withProfile(cronProfile, "cron-job-1", () =>
    delegate.decide(request({
      source: "local_tool",
      capability: { kind: "local_tool", target: "OTHER.md", action: "edit" },
      risk: "medium",
      display: { action: "edit", target: "OTHER.md" },
    })));

  assertEquals(sameTarget.decision, "allow");
  assertEquals(differentTarget.reason, "cron_permission_not_preapproved");
});

Deno.test("cron capability delegate allows low-risk workspace read-only local tools", async () => {
  const delegate = createCronCapabilityDelegate(baseDelegate());
  const cronProfile: CronPermissionProfile = {
    localToolPolicy: "workspace-readonly",
    toolRules: [],
    brokerRules: [],
  };
  const operations = ["read", "list", "find", "grep", "skill"] as const;

  const decisions = await delegate.withProfile(cronProfile, "job", () =>
    Promise.all(
      operations.map((operation) =>
        delegate.decide(request({
          source: "local_tool",
          capability: {
            kind: "local_tool",
            target: operation === "list" ? "." : "src/cron/permissions.ts",
            action: operation,
          },
          risk: "low",
          display: {
            action: operation,
            target: operation === "list" ? "." : "src/cron/permissions.ts",
          },
        }))
      ),
    ));

  assertEquals(decisions.map((decision) => decision.decision), ["allow", "allow", "allow", "allow", "allow"]);
});

Deno.test("cron capability delegate denies shell and host-path requests under workspace read-only policy", async () => {
  const delegate = createCronCapabilityDelegate(baseDelegate());
  const cronProfile: CronPermissionProfile = {
    localToolPolicy: "workspace-readonly",
    toolRules: [],
    brokerRules: [],
  };

  const [shell, hostRead, hostSkill] = await delegate.withProfile(cronProfile, "job", () =>
    Promise.all([
      delegate.decide(request({
        source: "local_tool",
        capability: { kind: "local_tool", target: "ls", action: "shell" },
        risk: "high",
        display: { action: "shell", target: "ls" },
      })),
      delegate.decide(request({
        source: "local_tool",
        capability: { kind: "local_tool", target: "/tmp/secret.txt", action: "read" },
        risk: "high",
        display: { action: "read", target: "/tmp/secret.txt" },
      })),
      delegate.decide(request({
        source: "local_tool",
        capability: { kind: "local_tool", target: "/Users/peter/.agents/skills/secret/SKILL.md", action: "skill" },
        risk: "low",
        display: { action: "skill", target: "/Users/peter/.agents/skills/secret/SKILL.md" },
      })),
    ]));

  assertEquals(shell.reason, "cron_permission_not_preapproved");
  assertEquals(hostRead.reason, "cron_permission_not_preapproved");
  assertEquals(hostSkill.reason, "cron_permission_not_preapproved");
});

Deno.test("cron capability delegate answers broker prompts from active profile", async () => {
  const base = baseDelegate();
  const delegate = createCronCapabilityDelegate(base);

  const result = await delegate.withProfile(profile, "cron-job-1", () =>
    delegate.decide(request({
      source: "broker_permission",
      capability: { kind: "broker_permission", target: "gmail.googleapis.com:443", action: "net" },
      risk: "high",
      display: { action: "net", target: "gmail.googleapis.com:443" },
    })));

  assertEquals(result.decision, "allow");
  assertEquals(result.source, "policy");
  assertEquals(base.requests.length, 0);
});

Deno.test("cron capability delegate delegates unmatched broker prompts and caches approved rules", async () => {
  const base = baseDelegate({ decision: "allow", reason: "approved" });
  const delegate = createCronCapabilityDelegate(base);
  const cachedRules: { permission: string; value: string | null }[] = [];

  const result = await delegate.withProfile(profile, "cron-job-1", () =>
    delegate.decide(request({
      source: "broker_permission",
      capability: { kind: "broker_permission", target: "/bin/zsh", action: "run" },
      risk: "high",
      display: { action: "run", target: "/bin/zsh" },
    })), {
    onApprovedBrokerRule: (rule) => {
      cachedRules.push(rule);
    },
  });

  assertEquals(result.decision, "allow");
  assertEquals(base.requests.length, 1);
  assertEquals(cachedRules, [{ permission: "run", value: "/bin/zsh" }]);
});
