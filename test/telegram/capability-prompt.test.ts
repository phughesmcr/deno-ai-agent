// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.
import { assertEquals } from "jsr:@std/assert@1";

import type { CapabilityRequest } from "../../src/core/mod.ts";
import {
  createTelegramCapabilityPromptPort,
  type TelegramCapabilityCallbackContext,
  type TelegramCapabilityTurnContext,
} from "../../src/telegram/capability-prompt.ts";
import { encodeCapabilityCallback, toShortCapabilityRequestId } from "../../src/telegram/capability-callback.ts";

type FakeCapabilityContext = TelegramCapabilityTurnContext & TelegramCapabilityCallbackContext & {
  replies: string[];
  callbackAnswers: string[];
  markupsEdited: number;
  failSend?: boolean;
};

function localRequest(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    id: "approval-1",
    sessionId: "session-1",
    workId: "turn-1",
    source: "local_tool",
    capability: { kind: "local_tool", target: "notes.txt", action: "write" },
    risk: "medium",
    summary: "write 4 bytes",
    timeoutMs: 1_000,
    display: {
      action: "write",
      target: "notes.txt",
    },
    ...overrides,
  };
}

function brokerRequest(overrides: Partial<CapabilityRequest> = {}): CapabilityRequest {
  return {
    id: "12345678-1234-1234-1234-123456789abc",
    sessionId: "session-1",
    workId: "turn-1",
    source: "broker_permission",
    capability: { kind: "broker_permission", target: "deno task test", action: "run" },
    risk: "high",
    timeoutMs: 1_000,
    display: {
      action: "run",
      target: "deno task test",
    },
    ...overrides,
  };
}

function fakeContext(adminId = 42): FakeCapabilityContext {
  return {
    config: { adminId, isAdmin: true },
    from: { id: adminId },
    message: { message_thread_id: 9, chat: { id: 123 } },
    replies: [],
    callbackAnswers: [],
    markupsEdited: 0,
    reply(text: string): Promise<{ message_id: number }> {
      if (this.failSend) return Promise.reject(new Error("send failed"));
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

function callbackData(requestId: string, action: "approve" | "once" | "session" | "deny"): string {
  return encodeCapabilityCallback(toShortCapabilityRequestId(requestId), action);
}

Deno.test("Telegram capability prompt approves and denies app callbacks", async () => {
  const port = createTelegramCapabilityPromptPort();
  const ctx = fakeContext();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const pendingApprove = port.decide(localRequest({ id: "approval-a" }));
  await Promise.resolve();
  await port.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: callbackData("approval-a", "approve") },
  });
  assertEquals(await pendingApprove, {
    decision: "allow",
    scope: "once",
    reason: "approved",
    decidedAt: (await pendingApprove).decidedAt,
    decidedBy: "42",
  });

  const pendingDeny = port.decide(localRequest({ id: "approval-b" }));
  await Promise.resolve();
  await port.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: callbackData("approval-b", "deny") },
  });
  const denied = await pendingDeny;
  assertEquals(denied.decision, "deny");
  assertEquals(denied.scope, "once");
  assertEquals(denied.reason, "denied");
});

Deno.test("Telegram capability prompt resolves broker once session and deny callbacks", async () => {
  const port = createTelegramCapabilityPromptPort();
  const ctx = fakeContext();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const once = brokerRequest({ id: "aaaaaaaa-1111-1111-1111-111111111111" });
  const pendingOnce = port.decide(once);
  await Promise.resolve();
  await port.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: callbackData(once.id, "once") },
  });
  assertEquals((await pendingOnce).scope, "once");
  assertEquals((await pendingOnce).decision, "allow");

  const session = brokerRequest({ id: "bbbbbbbb-2222-2222-2222-222222222222" });
  const pendingSession = port.decide(session);
  await Promise.resolve();
  await port.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: callbackData(session.id, "session") },
  });
  assertEquals((await pendingSession).scope, "session");
  assertEquals((await pendingSession).decision, "allow");

  const deny = brokerRequest({ id: "cccccccc-3333-3333-3333-333333333333" });
  const pendingDeny = port.decide(deny);
  await Promise.resolve();
  await port.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: callbackData(deny.id, "deny") },
  });
  assertEquals((await pendingDeny).decision, "deny");
});

Deno.test("Telegram capability prompt queues mixed prompts sequentially", async () => {
  const port = createTelegramCapabilityPromptPort();
  const ctx = fakeContext();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const first = localRequest({ id: "approval-a" });
  const second = brokerRequest({ id: "bbbbbbbb-2222-2222-2222-222222222222" });
  const pendingFirst = port.decide(first);
  const pendingSecond = port.decide(second);
  await Promise.resolve();

  assertEquals(ctx.replies.length, 1);
  assertEquals(port.isPending(), true);

  await port.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: callbackData(first.id, "approve") },
  });
  assertEquals((await pendingFirst).decision, "allow");
  await Promise.resolve();
  assertEquals(ctx.replies.length, 2);

  await port.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: callbackData(second.id, "session") },
  });
  assertEquals((await pendingSecond).scope, "session");
  assertEquals(port.isPending(), false);
});

Deno.test("Telegram capability prompt handles wrong-user stale timeout abort and send failure", async () => {
  const port = createTelegramCapabilityPromptPort(5);
  const ctx = fakeContext();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = port.decide(localRequest({ id: "current" }));
  await Promise.resolve();

  const wrongUser = fakeContext();
  await port.handleCallback({
    ...wrongUser,
    from: { id: 7 },
    callbackQuery: { data: callbackData("current", "approve") },
  });
  assertEquals(wrongUser.callbackAnswers.at(-1), "Not authorized.");
  assertEquals(port.isPending(), true);

  const stale = fakeContext();
  await port.handleCallback({
    ...stale,
    callbackQuery: { data: callbackData("old", "approve") },
  });
  assertEquals(stale.callbackAnswers.at(-1), "This approval has expired.");
  assertEquals(port.isPending(), true);

  await port.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: callbackData("current", "deny") },
  });
  assertEquals((await pending).decision, "deny");

  const timedOut = await port.decide(localRequest({ id: "timeout", timeoutMs: 1 }));
  assertEquals(timedOut.reason, "timeout");

  const abortController = new AbortController();
  port.setTurnContext({ ctx, signal: abortController.signal });
  const aborted = port.decide(localRequest({ id: "abort" }));
  await Promise.resolve();
  abortController.abort();
  assertEquals((await aborted).reason, "cancelled");

  const sendFailPort = createTelegramCapabilityPromptPort();
  const sendFailCtx = fakeContext();
  sendFailCtx.failSend = true;
  sendFailPort.setTurnContext({ ctx: sendFailCtx, signal: new AbortController().signal });
  const sendFailed = await sendFailPort.decide(localRequest({ id: "send-fail" }));
  assertEquals(sendFailed.reason, "send_failed");
});

Deno.test("Telegram capability prompt denies when no turn context is active", async () => {
  const port = createTelegramCapabilityPromptPort();

  const decision = await port.decide(localRequest());

  assertEquals(decision.decision, "deny");
  assertEquals(decision.reason, "missing_telegram_turn");
});
