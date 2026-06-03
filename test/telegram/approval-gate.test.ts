// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.
import { assertEquals } from "jsr:@std/assert@1";

import type { ApprovalRequest } from "../../src/shared/approval.ts";
import { createTelegramApprovalGate, encodeApprovalCallback } from "../../src/telegram/approval-gate.ts";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    operation: "write",
    target: "notes.txt",
    risk: "medium",
    sessionId: "session-1",
    turnId: "turn-1",
    timeoutMs: 1_000,
    ...overrides,
  };
}

interface FakeContext {
  config: { adminId: number; isAdmin: boolean };
  from?: { id: number };
  callbackQuery?: { data?: string };
  message?: { message_thread_id?: number };
  replies: string[];
  callbackAnswers: string[];
  markupsEdited: number;
  reply(text: string, _options?: unknown): Promise<{ message_id: number }>;
  answerCallbackQuery(options?: { text?: string }): Promise<void>;
  editMessageReplyMarkup(_options?: unknown): Promise<void>;
}

function fakeContext(adminId = 42): FakeContext {
  return {
    config: { adminId, isAdmin: true },
    from: { id: adminId },
    replies: [],
    callbackAnswers: [],
    markupsEdited: 0,
    reply(text: string): Promise<{ message_id: number }> {
      this.replies.push(text);
      return Promise.resolve({ message_id: this.replies.length });
    },
    answerCallbackQuery(options?: { text?: string }): Promise<void> {
      this.callbackAnswers.push(options?.text ?? "");
      return Promise.resolve();
    },
    editMessageReplyMarkup(): Promise<void> {
      this.markupsEdited++;
      return Promise.resolve();
    },
  };
}

Deno.test("Telegram approval gate approves matching admin callbacks", async () => {
  const gate = createTelegramApprovalGate();
  const ctx = fakeContext();
  gate.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = gate.requestApproval(request());
  await Promise.resolve();
  assertEquals(gate.isPending(), true);

  await gate.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: encodeApprovalCallback("approval-1", "approve") },
  });

  const decision = await pending;
  assertEquals(decision.approved, true);
  assertEquals(decision.reason, "approved");
  assertEquals(gate.isPending(), false);
});

Deno.test("Telegram approval gate denies matching admin deny callbacks", async () => {
  const gate = createTelegramApprovalGate();
  const ctx = fakeContext();
  gate.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = gate.requestApproval(request());
  await Promise.resolve();

  await gate.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: encodeApprovalCallback("approval-1", "deny") },
  });

  const decision = await pending;
  assertEquals(decision.approved, false);
  assertEquals(decision.reason, "denied");
});

Deno.test("Telegram approval gate denies on timeout", async () => {
  const gate = createTelegramApprovalGate();
  const ctx = fakeContext();
  gate.setTurnContext({ ctx, signal: new AbortController().signal });

  const decision = await gate.requestApproval(request({ timeoutMs: 1 }));

  assertEquals(decision.approved, false);
  assertEquals(decision.reason, "timeout");
});

Deno.test("Telegram approval gate ignores stale callbacks while pending", async () => {
  const gate = createTelegramApprovalGate();
  const ctx = fakeContext();
  gate.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = gate.requestApproval(request({ id: "current" }));
  await Promise.resolve();

  const staleCtx = fakeContext();
  await gate.handleCallback({
    ...staleCtx,
    callbackQuery: { data: encodeApprovalCallback("old", "approve") },
  });
  assertEquals(staleCtx.callbackAnswers.at(-1), "This approval has expired.");

  await gate.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: encodeApprovalCallback("current", "approve") },
  });

  const decision = await pending;
  assertEquals(decision.approved, true);
  assertEquals(decision.reason, "approved");
});

Deno.test("Telegram approval gate leaves pending approval untouched for wrong-user callbacks", async () => {
  const gate = createTelegramApprovalGate();
  const ctx = fakeContext();
  gate.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = gate.requestApproval(request());
  await Promise.resolve();

  const wrongUserCtx = fakeContext();
  await gate.handleCallback({
    ...wrongUserCtx,
    from: { id: 7 },
    callbackQuery: { data: encodeApprovalCallback("approval-1", "approve") },
  });

  assertEquals(gate.isPending(), true);
  assertEquals(wrongUserCtx.callbackAnswers.at(-1), "Not authorized.");

  await gate.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: encodeApprovalCallback("approval-1", "deny") },
  });

  const decision = await pending;
  assertEquals(decision.approved, false);
  assertEquals(decision.reason, "denied");
});

Deno.test("Telegram approval gate denies when no turn context is active", async () => {
  const gate = createTelegramApprovalGate();

  const decision = await gate.requestApproval(request());

  assertEquals(decision.approved, false);
  assertEquals(decision.reason, "missing_telegram_turn");
});

Deno.test("Telegram approval gate denies when the turn is aborted", async () => {
  const gate = createTelegramApprovalGate();
  const controller = new AbortController();
  const ctx = fakeContext();
  gate.setTurnContext({ ctx, signal: controller.signal });

  const pending = gate.requestApproval(request());
  await Promise.resolve();
  controller.abort();

  const decision = await pending;
  assertEquals(decision.approved, false);
  assertEquals(decision.reason, "cancelled");
});
