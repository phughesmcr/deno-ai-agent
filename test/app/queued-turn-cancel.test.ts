import { assertEquals } from "jsr:@std/assert@1";
import type { ChatMessageData } from "@lmstudio/sdk";

import { cancelQueuedTelegramUserTurns } from "../../src/app/queued-turn-cancel.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

const message = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
} as ChatMessageData;

const durableImages = [{ imageId: "image-1", fileName: "telegram.png", chunkCount: 2 }];

function payload(chatId: number, threadId?: number): unknown {
  return {
    input: { message, durableImages },
    telegram: {
      chatId,
      ...(threadId !== undefined ? { threadId } : {}),
      replyToMessageId: 10,
      updateId: 20,
    },
  };
}

Deno.test("cancelQueuedTelegramUserTurns cancels queued user turns for the target Telegram topic", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const matching = await queue.submit({
    id: "matching-work",
    kind: "user_turn",
    sessionId: "session-a",
    payload: payload(1, 2),
  });
  const otherTopic = await queue.submit({
    id: "other-topic-work",
    kind: "user_turn",
    sessionId: "session-a",
    payload: payload(1, 3),
  });
  const otherChat = await queue.submit({
    id: "other-chat-work",
    kind: "user_turn",
    sessionId: "session-a",
    payload: payload(4, 2),
  });

  const result = await cancelQueuedTelegramUserTurns({
    events,
    queue,
    target: { chatId: 1, threadId: 2 },
    now: new Date("2026-06-08T10:00:00.000Z"),
    reason: "User requested cancellation.",
  });

  assertEquals(result, {
    cancelledWorkIds: [matching.id],
    durableImages,
  });
  assertEquals((await queue.get(matching.id))?.status, "cancelled");
  assertEquals((await queue.get(matching.id))?.failure, "User requested cancellation.");
  assertEquals((await queue.get(otherTopic.id))?.status, "queued");
  assertEquals((await queue.get(otherChat.id))?.status, "queued");
  assertEquals((await events.listByWork(matching.id)).map((event) => event.category), [
    "work.created",
    "work.cancelled",
  ]);
});

Deno.test("cancelQueuedTelegramUserTurns does not cancel leased active work", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const work = await queue.submit({
    id: "leased-work",
    kind: "user_turn",
    sessionId: "session-a",
    payload: payload(1),
    availableAt: new Date("2026-06-08T09:59:00.000Z"),
  });
  await queue.lease(work.id, {
    ownerId: "host-a",
    kinds: ["user_turn"],
    now: new Date("2026-06-08T10:00:00.000Z"),
  });

  const result = await cancelQueuedTelegramUserTurns({
    events,
    queue,
    target: { chatId: 1 },
    now: new Date("2026-06-08T10:00:01.000Z"),
  });

  assertEquals(result, {
    cancelledWorkIds: [],
    durableImages: [],
  });
  assertEquals((await queue.get(work.id))?.status, "leased");
  assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
    "work.created",
    "work.leased",
  ]);
});

Deno.test("cancelQueuedTelegramUserTurns keeps main chat and topic queues separate", async () => {
  const events = new MemoryKernelStore();
  const queue = events;
  const mainChat = await queue.submit({
    id: "main-chat-work",
    kind: "user_turn",
    sessionId: "session-a",
    payload: payload(1),
  });
  const topic = await queue.submit({
    id: "topic-work",
    kind: "user_turn",
    sessionId: "session-a",
    payload: payload(1, 2),
  });

  const result = await cancelQueuedTelegramUserTurns({
    events,
    queue,
    target: { chatId: 1 },
  });

  assertEquals(result.cancelledWorkIds, [mainChat.id]);
  assertEquals((await queue.get(mainChat.id))?.status, "cancelled");
  assertEquals((await queue.get(topic.id))?.status, "queued");
});
