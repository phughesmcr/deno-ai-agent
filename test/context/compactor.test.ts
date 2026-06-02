import { Chat, ChatMessage, type ChatMessageData, type LLM, type Tool } from "@lmstudio/sdk";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

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

function skillToolMessage(name: string, body: string): ChatMessage {
  return ChatMessage.from(rawToolMessage(`<skill_content name="${name}">\n${body}\n</skill_content>`));
}

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

function snapshot(chat: Chat): [string, string][] {
  return chat.getMessagesArray().map((message) => [message.getRole(), message.getText() || message.toString()]);
}

Deno.test("createSummaryCompactor preserves latest skill content outside the summary", async () => {
  const chat = Chat.empty();
  chat.replaceSystemPrompt("system prompt");
  chat.append("user", "first");
  chat.append(skillToolMessage("docs", "old docs instructions"));
  chat.append("assistant", "second");
  chat.append("user", "third");
  chat.append(skillToolMessage("docs", "new docs instructions"));
  chat.append("assistant", "fourth");
  chat.append("user", "fifth");
  chat.append("assistant", "sixth");
  chat.append("user", "seventh");

  const model = new FakeSummaryModel();
  const compact = createSummaryCompactor(model as unknown as LLM);

  const compacted = await compact(chat);
  const compactedText = compacted.getMessagesArray().map((message) => message.toString()).join("\n");
  const summaryInput = model.actCalls[0]?.getMessagesArray().at(-1)?.toString() ?? "";

  assertStringIncludes(compactedText, '<skill_content name="docs">');
  assertStringIncludes(compactedText, "new docs instructions");
  assertEquals(compactedText.includes("old docs instructions"), false);
  assertEquals((compactedText.match(/<skill_content name="docs">/g) ?? []).length, 1);
  assertEquals(summaryInput.includes("<skill_content"), false);

  const messages = snapshot(compacted);
  const skillIndex = messages.findIndex(([, text]) => text.includes('<skill_content name="docs">'));
  const recentIndex = messages.findIndex(([, text]) => text.includes("fourth"));
  assert(skillIndex !== -1);
  assert(recentIndex !== -1);
  assert(skillIndex < recentIndex);
  assertEquals(messages[0], ["system", "system prompt"]);
  assertEquals(messages[1], ["user", "[Earlier conversation summary]\nshort summary"]);
});

Deno.test("createSummaryCompactor leaves chats without skill content unchanged apart from normal summary", async () => {
  const chat = Chat.empty();
  chat.replaceSystemPrompt("system prompt");
  for (
    const [role, text] of [
      ["user", "one"],
      ["assistant", "two"],
      ["user", "three"],
      ["assistant", "four"],
      ["user", "five"],
      ["assistant", "six"],
      ["user", "seven"],
      ["assistant", "eight"],
    ] as const
  ) {
    chat.append(ChatMessage.from(rawMessage(role, text)));
  }

  const model = new FakeSummaryModel();
  const compacted = await createSummaryCompactor(model as unknown as LLM)(chat);

  assertEquals(snapshot(compacted), [
    ["system", "system prompt"],
    ["user", "[Earlier conversation summary]\nshort summary"],
    ["user", "three"],
    ["assistant", "four"],
    ["user", "five"],
    ["assistant", "six"],
    ["user", "seven"],
    ["assistant", "eight"],
  ]);
});
