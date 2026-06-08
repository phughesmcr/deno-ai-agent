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
};

function fakeContext(adminId = 42): FakeCapabilityContext {
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

function request(): CapabilityRequest {
  return {
    id: "approval-1",
    sessionId: "session-1",
    workId: "turn-1",
    source: "local_tool",
    capability: { kind: "local_tool", target: "/Users/peter/.codex/config.toml", action: "read" },
    risk: "high",
    timeoutMs: 5_000,
    display: {
      action: "read",
      target: "/Users/peter/.codex/config.toml",
    },
  };
}

Deno.test("approval survives act signal abort when approve callback arrives", async () => {
  const prompt = createTelegramCapabilityPromptPort();
  const actController = new AbortController();
  const approvalController = new AbortController();
  const ctx = fakeContext();

  prompt.setTurnContext({ ctx, signal: approvalController.signal });

  const pending = prompt.decide(request());
  await Promise.resolve();

  actController.abort();

  await prompt.handleCallback({
    ...fakeContext(),
    callbackQuery: { data: encodeCapabilityCallback(toShortCapabilityRequestId("approval-1"), "approve") },
  });

  const decision = await pending;
  assertEquals(decision.decision, "allow");
  assertEquals(decision.reason, "approved");
});
