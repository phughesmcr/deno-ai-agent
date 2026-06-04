import { assertEquals } from "jsr:@std/assert@1";

import {
  createTelegramApprovalGate,
  encodeApprovalCallback,
  type TelegramApprovalCallbackContext,
  type TelegramApprovalTurnContext,
} from "../../src/telegram/approval-gate.ts";

type FakeApprovalContext = TelegramApprovalTurnContext & TelegramApprovalCallbackContext & {
  replies: string[];
  callbackAnswers: string[];
  markupsEdited: number;
};

function fakeContext(adminId = 42): FakeApprovalContext {
  return {
    config: { adminId, isAdmin: true },
    from: { id: adminId },
    replies: [] as string[],
    callbackAnswers: [] as string[],
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

Deno.test("approval survives act signal abort when approve callback arrives", async () => {
  const gate = createTelegramApprovalGate();
  const actController = new AbortController();
  const approvalController = new AbortController();
  const ctx = fakeContext();

  gate.setTurnContext({ ctx, signal: approvalController.signal });

  const pending = gate.requestApproval({
    id: "approval-1",
    operation: "read",
    target: "/Users/peter/.codex/config.toml",
    risk: "high",
    sessionId: "session-1",
    turnId: "turn-1",
    timeoutMs: 5_000,
  });
  await Promise.resolve();

  actController.abort();

  await gate.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: encodeApprovalCallback("approval-1", "approve") },
  });

  const decision = await pending;
  assertEquals(decision.approved, true);
  assertEquals(decision.reason, "approved");
});
