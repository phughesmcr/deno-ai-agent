import { assertEquals } from "jsr:@std/assert@1";

import {
  createCronApprovalGate,
  createCronPermissionPromptPort,
  type CronPermissionProfile,
} from "../../src/cron/permissions.ts";
import type { PermissionPromptPort, PermissionPromptRequest } from "../../src/permission-broker/mod.ts";

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

Deno.test("cron permission prompt port denies unmatched broker prompts without delegating", async () => {
  const base = fakePermissionPromptPort();
  const port = createCronPermissionPromptPort(base);

  const result = await port.withProfile(profile, "cron-job-1", () =>
    port.prompt({
      requestId: "request-1",
      brokerId: 1,
      permission: "run",
      value: "/bin/zsh",
    }));

  assertEquals(result, { result: "deny" });
  assertEquals(base.prompts.length, 0);
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
