import { ChatMessage, type ChatMessageData } from "@lmstudio/sdk";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { prepareSummaryCompaction } from "../../src/agent/context/compactor.ts";
import { withEnv } from "../_env.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

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

Deno.test("prepareSummaryCompaction uses structured prompt input and preserves latest skill content", () => {
  const messages = [
    rawMessage("user", "first"),
    skillToolMessage("docs", "old docs instructions"),
    rawMessage("assistant", "second"),
    skillToolMessage("docs", "new docs instructions"),
  ];

  const prepared = prepareSummaryCompaction({
    systemPrompt: "system prompt",
    previousSummary: "previous checkpoint",
    messages,
    instructions: "focus on files",
    details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
  });
  const summary = prepared.finish("short summary");

  assertEquals(prepared.systemPrompt, "system prompt");
  assertStringIncludes(summary, "short summary");
  assertStringIncludes(summary, '<skill_content name="docs">');
  assertStringIncludes(summary, "new docs instructions");
  assertEquals(summary.includes("old docs instructions"), false);
  assertStringIncludes(summary, "<read-files>\nsrc/a.ts\n</read-files>");
  assertStringIncludes(summary, "<modified-files>\nsrc/b.ts\n</modified-files>");
  assertStringIncludes(prepared.prompt, "Goal");
  assertStringIncludes(prepared.prompt, "Previous checkpoint summary:");
  assertStringIncludes(prepared.prompt, "Additional user compaction instructions:");
});

Deno.test("prepareSummaryCompaction truncates large tool output in summary input", () => {
  const prepared = prepareSummaryCompaction({
    systemPrompt: "system prompt",
    messages: [rawToolMessage("abcdefghijklmnopqrstuvwxyz")],
    details: { readFiles: [], modifiedFiles: [] },
  }, 12);

  assertStringIncludes(prepared.prompt, "abcdefghijkl");
  assertStringIncludes(prepared.prompt, "[tool result truncated at 12 chars]");
  assertEquals(prepared.prompt.includes("mnopqrstuvwxyz"), false);
});

Deno.test("prepareSummaryCompaction serializes image attachment metadata", () => {
  const imagePart = {
    type: "file",
    name: "photo.jpg",
    identifier: "id-1",
    sizeBytes: 100,
    fileType: "image",
  } as const;

  const prepared = prepareSummaryCompaction({
    systemPrompt: "system prompt",
    messages: [{ role: "user", content: [{ type: "text", text: "see this" }, imagePart] }],
    details: { readFiles: [], modifiedFiles: [] },
  });

  assertStringIncludes(prepared.prompt, "attachments: 1 image(s): photo.jpg");
});

Deno.test("prepareSummaryCompaction strips reasoning from summary when KEEP_THINKING=false", async () => {
  await withEnv({ KEEP_THINKING: "false" }, () => {
    const prepared = prepareSummaryCompaction({
      systemPrompt: "system prompt",
      messages: [rawMessage("user", "fold me")],
      details: { readFiles: [], modifiedFiles: [] },
    });
    const summary = prepared.finish("<think>x</think>Goal\n- item");

    assertStringIncludes(summary, "Goal");
    assertEquals(summary.includes("<think>"), false);
    assertEquals(summary.includes("</think>"), false);
  });
});

Deno.test("prepareSummaryCompaction keeps reasoning in summary when KEEP_THINKING=true", async () => {
  await withEnv({ KEEP_THINKING: "true" }, () => {
    const prepared = prepareSummaryCompaction({
      systemPrompt: "system prompt",
      messages: [rawMessage("user", "fold me")],
      details: { readFiles: [], modifiedFiles: [] },
    });
    const summary = prepared.finish("<think>x</think>Goal\n- item");

    assertStringIncludes(summary, "<think>x</think>Goal");
  });
});
