import { assertEquals } from "jsr:@std/assert@1";

import {
  createCronApprovalGate,
  createCronPermissionPromptPort,
  type CronPermissionProfile,
} from "../../src/cron/permissions.ts";
import type { PermissionPromptPort, PermissionPromptRequest } from "../../src/permission-broker/mod.ts";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../../src/shared/approval.ts";
import { approveDecision } from "../../src/shared/approval.ts";

const profile: CronPermissionProfile = {
  toolRules: [
    { operation: "mcp", target: "gmail/search" },
    { operation: "mcp", target: "gmail/read" },
  ],
  brokerRules: [
    { permission: "net", value: "gmail.googleapis.com:443" },
  ],
};

Deno.test("cron approval gate allows exact pre-approved tool targets", async () => {
  const gate = createCronApprovalGate(profile, "cron-job-1");

  const decision = await gate.requestApproval({
    operation: "mcp",
    target: "gmail/search",
    risk: "high",
    sessionId: "session",
    turnId: "turn",
    timeoutMs: 1_000,
  });

  assertEquals(decision, {
    approved: true,
    reason: "approved",
    decidedAt: decision.decidedAt,
    decidedBy: "cron:cron-job-1",
  });
});

Deno.test("cron approval gate denies unknown tool targets", async () => {
  const gate = createCronApprovalGate(profile, "cron-job-1");

  const decision = await gate.requestApproval({
    operation: "mcp",
    target: "gmail/delete",
    risk: "high",
    sessionId: "session",
    turnId: "turn",
    timeoutMs: 1_000,
  });

  assertEquals(decision.approved, false);
  assertEquals(decision.reason, "cron_permission_not_preapproved");
});

Deno.test("cron approval gate delegates unmatched requests to fallback approval gate", async () => {
  const fallbackRequests: ApprovalRequest[] = [];
  const cachedRules: { operation: string; target: string }[] = [];
  const fallback: ApprovalGate = {
    isPending: () => true,
    requestApproval(request): Promise<ApprovalDecision> {
      fallbackRequests.push(request);
      return Promise.resolve(approveDecision("telegram"));
    },
  };
  const gate = createCronApprovalGate(profile, "cron-job-1", fallback, (rule) => {
    cachedRules.push(rule);
  });

  const decision = await gate.requestApproval({
    operation: "write",
    target: "MEMORY.md",
    risk: "low",
    sessionId: "session",
    turnId: "turn",
    timeoutMs: 1_000,
  });

  assertEquals(decision.approved, true);
  assertEquals(decision.decidedBy, "telegram");
  assertEquals(gate.isPending?.(), true);
  assertEquals(fallbackRequests.map((request) => request.target), ["MEMORY.md"]);
  assertEquals(cachedRules, [{ operation: "write", target: "MEMORY.md" }]);
});

Deno.test("cron approval gate treats same-target write and edit approvals as equivalent", async () => {
  const gate = createCronApprovalGate({
    toolRules: [{ operation: "write", target: "MEMORY.md" }],
    brokerRules: [],
  }, "cron-job-1");

  const sameTarget = await gate.requestApproval({
    operation: "edit",
    target: "MEMORY.md",
    risk: "medium",
    sessionId: "new-session",
    turnId: "cron:cron-job-1",
    timeoutMs: 1_000,
  });
  const differentTarget = await gate.requestApproval({
    operation: "edit",
    target: "OTHER.md",
    risk: "medium",
    sessionId: "new-session",
    turnId: "cron:cron-job-1",
    timeoutMs: 1_000,
  });

  assertEquals(sameTarget.approved, true);
  assertEquals(differentTarget.reason, "cron_permission_not_preapproved");
});

Deno.test("cron approval gate allows low-risk workspace read-only local tools", async () => {
  const gate = createCronApprovalGate({ localToolPolicy: "workspace-readonly", toolRules: [], brokerRules: [] }, "job");
  const operations = ["read", "list", "find", "grep", "skill"] as const;

  const decisions = await Promise.all(
    operations.map((operation) =>
      gate.requestApproval({
        operation,
        target: operation === "list" ? "." : "src/cron/permissions.ts",
        risk: "low",
        sessionId: "session",
        turnId: "turn",
        timeoutMs: 1_000,
      })
    ),
  );

  assertEquals(decisions.map((decision) => decision.approved), [true, true, true, true, true]);
});

Deno.test("cron approval gate denies shell and host-path requests under workspace read-only policy", async () => {
  const gate = createCronApprovalGate({ localToolPolicy: "workspace-readonly", toolRules: [], brokerRules: [] }, "job");

  const [shell, hostRead, hostSkill] = await Promise.all([
    gate.requestApproval({
      operation: "shell",
      target: "ls",
      risk: "high",
      sessionId: "session",
      turnId: "turn",
      timeoutMs: 1_000,
    }),
    gate.requestApproval({
      operation: "read",
      target: "/tmp/secret.txt",
      risk: "high",
      sessionId: "session",
      turnId: "turn",
      timeoutMs: 1_000,
    }),
    gate.requestApproval({
      operation: "skill",
      target: "/Users/peter/.agents/skills/secret/SKILL.md",
      risk: "low",
      sessionId: "session",
      turnId: "turn",
      timeoutMs: 1_000,
    }),
  ]);

  assertEquals(shell.reason, "cron_permission_not_preapproved");
  assertEquals(hostRead.reason, "cron_permission_not_preapproved");
  assertEquals(hostSkill.reason, "cron_permission_not_preapproved");
});

Deno.test("cron permission prompt port answers broker prompts from active profile", async () => {
  const base = fakePermissionPromptPort();
  const port = createCronPermissionPromptPort(base);
  const request: PermissionPromptRequest = {
    requestId: "request-1",
    brokerId: 1,
    permission: "net",
    value: "gmail.googleapis.com:443",
  };

  const result = await port.withProfile(profile, "cron-job-1", () => port.prompt(request));

  assertEquals(result, { result: "allow", grant: "once" });
  assertEquals(base.prompts.length, 0);
});

Deno.test("cron permission prompt port delegates unmatched broker prompts", async () => {
  const base = fakePermissionPromptPort({ result: "allow", grant: "once" });
  const port = createCronPermissionPromptPort(base);
  const cachedRules: { permission: string; value: string | null }[] = [];

  const result = await port.withProfile(profile, "cron-job-1", () =>
    port.prompt({
      requestId: "request-1",
      brokerId: 1,
      permission: "run",
      value: "/bin/zsh",
    }), {
    onApprovedBrokerRule: (rule) => {
      cachedRules.push(rule);
    },
  });

  assertEquals(result, { result: "allow", grant: "once" });
  assertEquals(base.prompts.length, 1);
  assertEquals(cachedRules, [{ permission: "run", value: "/bin/zsh" }]);
});

Deno.test("cron permission prompt port delegates outside cron runs", async () => {
  const base = fakePermissionPromptPort({ result: "allow", grant: "session" });
  const port = createCronPermissionPromptPort(base);

  const result = await port.prompt({
    requestId: "request-1",
    brokerId: 1,
    permission: "run",
    value: "/bin/zsh",
  });

  assertEquals(result, { result: "allow", grant: "session" });
  assertEquals(base.prompts.length, 1);
});

function fakePermissionPromptPort(
  result: { result: "allow" | "deny"; grant?: "once" | "session" } = { result: "deny" },
): PermissionPromptPort & { prompts: PermissionPromptRequest[] } {
  const prompts: PermissionPromptRequest[] = [];
  return {
    prompts,
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    abortPending: () => {},
    prompt: (request) => {
      prompts.push(request);
      return Promise.resolve(result);
    },
    handleCallback: () => Promise.resolve({ handled: false }),
  };
}
