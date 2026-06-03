import { type Chat, ChatMessage, type ChatMessageData, type LLM, type Tool } from "@lmstudio/sdk";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createSummaryCompactor } from "../../src/agent/context/compactor.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

interface FakeActOptions {
  onMessage?: (message: ChatMessage) => void;
}

class FakeSummaryModel {
  readonly actCalls: Chat[] = [];

  act(chat: Chat, _tools: Tool[], options: FakeActOptions): Promise<void> {
    this.actCalls.push(chat);
    options.onMessage?.(ChatMessage.create("assistant", "short summary"));
    return Promise.resolve();
  }
}

function rawToolMessage(content: string): ChatMessageData {
  return {
    role: "tool",
    content: [{ type: "toolCallResult", content, toolCallId: crypto.randomUUID() }],
  };
}

function skillToolMessage(name: string, body: string): ChatMessageData {
  return rawToolMessage(`<skill_content name="${name}">\n${body}\n</skill_content>`);
}

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

Deno.test("createSummaryCompactor uses structured prompt input and preserves latest skill content", async () => {
  const messages = [
    rawMessage("user", "first"),
    skillToolMessage("docs", "old docs instructions"),
    rawMessage("assistant", "second"),
    skillToolMessage("docs", "new docs instructions"),
  ];

  const model = new FakeSummaryModel();
  const compact = createSummaryCompactor(model as unknown as LLM);

  const summary = await compact({
    systemPrompt: "system prompt",
    previousSummary: "previous checkpoint",
    messages,
    instructions: "focus on files",
    details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
  });
  const summaryInput = model.actCalls[0]?.getMessagesArray().at(-1)?.toString() ?? "";

  assertStringIncludes(summary, "short summary");
  assertStringIncludes(summary, '<skill_content name="docs">');
  assertStringIncludes(summary, "new docs instructions");
  assertEquals(summary.includes("old docs instructions"), false);
  assertStringIncludes(summary, "<read-files>\nsrc/a.ts\n</read-files>");
  assertStringIncludes(summary, "<modified-files>\nsrc/b.ts\n</modified-files>");
  assertStringIncludes(summaryInput, "Goal");
  assertStringIncludes(summaryInput, "Previous checkpoint summary:");
  assertStringIncludes(summaryInput, "Additional user compaction instructions:");
});

Deno.test("createSummaryCompactor truncates large tool output in summary input", async () => {
  const model = new FakeSummaryModel();
  const compact = createSummaryCompactor(model as unknown as LLM, undefined, 12);

  await compact({
    systemPrompt: "system prompt",
    messages: [rawToolMessage("abcdefghijklmnopqrstuvwxyz")],
    details: { readFiles: [], modifiedFiles: [] },
  });

  const summaryInput = model.actCalls[0]?.getMessagesArray().at(-1)?.toString() ?? "";
  assertStringIncludes(summaryInput, "abcdefghijkl");
  assertStringIncludes(summaryInput, "[tool result truncated at 12 chars]");
  assertEquals(summaryInput.includes("mnopqrstuvwxyz"), false);
});
