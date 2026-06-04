import { ChatMessage, type ChatMessageData, type LMStudioClient } from "@lmstudio/sdk";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { imageFileParts, materializeMessageForChat } from "../../src/agent/context/message-materialize.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function userMessageWithImage(name: string, identifier: string): ChatMessageData {
  return {
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "file", name, identifier, sizeBytes: 70, fileType: "image" },
    ],
  };
}

Deno.test("materializeMessageForChat returns plain message when no images", () => {
  const client = {} as LMStudioClient;
  const data = (ChatMessage.create("user", "hello") as ChatMessageWithRaw).getRaw();
  const message = materializeMessageForChat(client, data);
  assertEquals(message.getRole(), "user");
  assertEquals(message.getText(), "hello");
  assertEquals(imageFileParts((message as ChatMessageWithRaw).getRaw()).length, 0);
});

Deno.test("materializeMessageForChat uses placeholders when rehydrate fails", () => {
  const client = {
    files: {
      createFileHandleFromChatMessagePartFileData(): never {
        throw new Error("file gone");
      },
    },
  } as unknown as LMStudioClient;

  const message = materializeMessageForChat(client, userMessageWithImage("gone.png", "stale-id"));
  const raw = (message as ChatMessageWithRaw).getRaw();
  assertEquals(imageFileParts(raw).length, 0);
  assertStringIncludes(message.getText(), "gone.png");
  assertStringIncludes(message.getText(), "not available after reload");
});

Deno.test({
  name: "materializeMessageForChat rehydrates when LM Studio has the file",
  ignore: !Deno.env.get("LMSTUDIO_IMAGE_TEST"),
}, async () => {
  const { LMStudioClient } = await import("@lmstudio/sdk");
  const client = new LMStudioClient();
  const handle = await client.files.prepareImageBase64("rehydrate.png", TINY_PNG_BASE64);
  const withHandle = ChatMessage.create("user", "look") as ChatMessageWithRaw;
  withHandle.appendFile(handle);
  const data = withHandle.getRaw();

  const message = materializeMessageForChat(client, data);
  const raw = (message as ChatMessageWithRaw).getRaw();
  assertEquals(imageFileParts(raw).length, 1);
  assertStringIncludes(message.getText(), "look");
});
