import { ChatMessage, type ChatMessageData } from "@lmstudio/sdk";
import { assertEquals } from "jsr:@std/assert@1/equals";

import { chatMessageForPersistence } from "../../src/agent/context/persisted-message.ts";
import { withEnv } from "../_env.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

function raw(message: ChatMessage): ChatMessageData {
  return (message as ChatMessageWithRaw).getRaw();
}

Deno.test("chatMessageForPersistence is unchanged when KEEP_THINKING=true", async () => {
  await withEnv({ KEEP_THINKING: "true" }, () => {
    const text = "<think>x</think>visible";
    const message = ChatMessage.create("assistant", text);
    assertEquals(chatMessageForPersistence(message), message);
    assertEquals(chatMessageForPersistence(message).getText(), text);
  });
});

Deno.test("chatMessageForPersistence strips assistant text when KEEP_THINKING=false", async () => {
  await withEnv({ KEEP_THINKING: "false" }, () => {
    const message = ChatMessage.create("assistant", "<think>secret</think>visible");
    const persisted = chatMessageForPersistence(message);
    assertEquals(persisted.getText(), "visible");
    assertEquals(raw(persisted).content[0], { type: "text", text: "visible" });
  });
});

Deno.test("chatMessageForPersistence preserves tool calls when stripping text", async () => {
  await withEnv({ KEEP_THINKING: "false" }, () => {
    const message = ChatMessage.from(
      {
        role: "assistant",
        content: [
          { type: "text", text: "<think>t</think>plan" },
          {
            type: "toolCallRequest",
            toolCallRequest: {
              id: "call-1",
              type: "function",
              name: "read",
              arguments: { path: "a.ts" },
            },
          },
        ],
      } satisfies ChatMessageData,
    );

    const persisted = chatMessageForPersistence(message);
    const data = raw(persisted);
    assertEquals(data.content[0], { type: "text", text: "plan" });
    assertEquals(data.content[1]?.type, "toolCallRequest");
    if (data.content[1]?.type === "toolCallRequest") {
      assertEquals(data.content[1].toolCallRequest.name, "read");
    }
  });
});

Deno.test("chatMessageForPersistence passes through non-assistant roles", async () => {
  await withEnv({ KEEP_THINKING: "false" }, () => {
    const message = ChatMessage.from(
      {
        role: "tool",
        content: [{
          type: "toolCallResult",
          content: "<think>x</think>body",
          toolCallId: "tool-1",
        }],
      } satisfies ChatMessageData,
    );
    assertEquals(chatMessageForPersistence(message), message);
  });
});
