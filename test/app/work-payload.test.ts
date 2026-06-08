import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { ChatMessageData } from "@lmstudio/sdk";

import { cronRunWorkPayload, prepareQueuedModelMessage, userTurnWorkPayload } from "../../src/app/work-payload.ts";

const message: ChatMessageData = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
} as ChatMessageData;

Deno.test("userTurnWorkPayload parses durable Telegram user turns", () => {
  assertEquals(
    userTurnWorkPayload({
      input: { message },
      telegram: { chatId: 1, threadId: 2, replyToMessageId: 3, updateId: 4 },
    }),
    {
      input: { message },
      telegram: { chatId: 1, threadId: 2, replyToMessageId: 3, updateId: 4 },
    },
  );
});

Deno.test("userTurnWorkPayload parses durable image payloads", () => {
  const durableImages = [{ imageId: "image-1", fileName: "telegram.png", chunkCount: 1 }];

  assertEquals(
    userTurnWorkPayload({
      input: { message, durableImages },
      telegram: { chatId: 1, replyToMessageId: 3 },
    }),
    {
      input: { message, durableImages },
      telegram: { chatId: 1, replyToMessageId: 3 },
    },
  );
});

Deno.test("prepareQueuedModelMessage re-prepares durable images from payload bytes", async () => {
  const durableImages = [{ imageId: "image-1", fileName: "telegram.png", chunkCount: 1 }];
  const loadedImages = [{ fileName: "telegram.png", base64: "aW1hZ2U=" }];
  const imageMessage = {
    role: "user",
    content: [
      { type: "text", text: "describe" },
      { type: "file", fileType: "image", name: "stale.png", identifier: "stale-id" },
    ],
  } as unknown as ChatMessageData;
  let loadedRefs: unknown;
  let preparedImages: unknown;

  const prepared = await prepareQueuedModelMessage(
    { message: imageMessage, durableImages },
    (images) => {
      loadedRefs = images;
      return Promise.resolve(loadedImages);
    },
    (images) => {
      preparedImages = images;
      return Promise.resolve([]);
    },
  );

  assertEquals(loadedRefs, durableImages);
  assertEquals(preparedImages, loadedImages);
  assertEquals(prepared, {
    role: "user",
    content: [{ type: "text", text: "describe" }],
  });
});

Deno.test("userTurnWorkPayload rejects missing model input", async () => {
  await assertRejects(
    () =>
      Promise.try(() =>
        userTurnWorkPayload({
          input: { text: "legacy payload without message data" },
          telegram: { chatId: 1, replyToMessageId: 3 },
        })
      ),
    Error,
    "Invalid user turn payload",
  );
});

Deno.test("cronRunWorkPayload parses durable cron runs", () => {
  assertEquals(
    cronRunWorkPayload({
      input: { message },
      telegram: { chatId: 1, replyToMessageId: 3, cronJobId: "cron-a" },
      prompt: "check mail",
      cron: {
        jobId: "cron-a",
        topicName: "Cron",
        sessionMode: "fresh",
        dueAt: "2026-06-06T07:00:00.000Z",
        dispatchedAt: "2026-06-06T07:00:03.000Z",
      },
    }),
    {
      input: { message },
      telegram: { chatId: 1, replyToMessageId: 3, cronJobId: "cron-a" },
      prompt: "check mail",
      cron: {
        jobId: "cron-a",
        topicName: "Cron",
        sessionMode: "fresh",
        dueAt: "2026-06-06T07:00:00.000Z",
        dispatchedAt: "2026-06-06T07:00:03.000Z",
      },
    },
  );
});
