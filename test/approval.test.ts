import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  type ApprovalDecision,
  ApprovalDeniedError,
  type ApprovalGate,
  type ApprovalRequest,
  createAutoApprovalGate,
  createDenyApprovalGate,
  requireApproval,
} from "../src/approval.ts";

Deno.test("requireApproval resolves approved decisions", async () => {
  const gate = createAutoApprovalGate("admin");
  const decision = await requireApproval(gate, {
    operation: "read",
    target: "a.txt",
    risk: "low",
    sessionId: "session-1",
    turnId: "turn-1",
    timeoutMs: 1000,
  });

  assertEquals(decision.approved, true);
  assertEquals(decision.decidedBy, "admin");
});

Deno.test("requireApproval throws for denied decisions", async () => {
  const gate = createDenyApprovalGate("not approved");

  const error = await assertRejects(
    () =>
      requireApproval(gate, {
        operation: "write",
        target: "a.txt",
        risk: "medium",
        sessionId: "session-1",
        turnId: "turn-1",
        timeoutMs: 1000,
      }),
    ApprovalDeniedError,
  );

  assertEquals(error.decision.approved, false);
  assertEquals(error.decision.reason, "not approved");
});

Deno.test("requireApproval passes abort signals through to the gate", async () => {
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  const gate: ApprovalGate = {
    requestApproval(_request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
      if (signal) seen.push(signal);
      return Promise.resolve({
        approved: true,
        decidedAt: new Date(0).toISOString(),
        reason: "approved",
      });
    },
  };

  await requireApproval(gate, {
    operation: "shell",
    target: "echo ok",
    risk: "high",
    sessionId: "session-1",
    turnId: "turn-1",
    timeoutMs: 1000,
  }, controller.signal);

  assertEquals(seen, [controller.signal]);
});
