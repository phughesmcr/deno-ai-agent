import { assertEquals } from "jsr:@std/assert@1";

import { type AlbumFlushPayload, createMediaGroupBuffer } from "../../src/telegram/media-group-buffer.ts";

function fakeTurnCtx(chatId: number, messageId: number, threadId?: number): AlbumFlushPayload["turnCtx"] {
  return {
    chat: { id: chatId },
    message: { message_id: messageId, message_thread_id: threadId },
    update: { update_id: 99 },
  } as AlbumFlushPayload["turnCtx"];
}

Deno.test("media group buffer debounces album photos into one flush", async () => {
  const flushed: AlbumFlushPayload[] = [];
  const buffer = createMediaGroupBuffer((payload) => {
    flushed.push(payload);
  });

  buffer.enqueue({
    mediaGroupId: "album-1",
    turnCtx: fakeTurnCtx(1, 10),
    context: { chatId: 1, replyToMessageId: 10 },
    item: { bytes: new Uint8Array([1]), fileName: "a.jpg" },
    caption: "first caption",
  });
  buffer.enqueue({
    mediaGroupId: "album-1",
    turnCtx: fakeTurnCtx(1, 11),
    context: { chatId: 1, replyToMessageId: 10 },
    item: { bytes: new Uint8Array([2]), fileName: "b.jpg" },
    caption: "ignored later caption",
  });

  await new Promise((resolve) => setTimeout(resolve, 700));

  assertEquals(flushed.length, 1);
  assertEquals(flushed[0]?.items.length, 2);
  assertEquals(flushed[0]?.text, "first caption");
  assertEquals(flushed[0]?.context.replyToMessageId, 10);

  buffer.dispose();
});

Deno.test("media group buffer caps images per album", async () => {
  Deno.env.set("LOG_LEVEL", "debug");
  const flushed: AlbumFlushPayload[] = [];
  const buffer = createMediaGroupBuffer((payload) => {
    flushed.push(payload);
  });

  for (let i = 0; i < 12; i += 1) {
    buffer.enqueue({
      mediaGroupId: "album-cap",
      turnCtx: fakeTurnCtx(2, 20),
      context: { chatId: 2, replyToMessageId: 20 },
      item: { bytes: new Uint8Array([i]), fileName: `${i}.jpg` },
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 700));

  assertEquals(flushed[0]?.items.length, 10);
  buffer.dispose();
});

Deno.test("flushPendingForConversation flushes before text handling", async () => {
  const flushed: AlbumFlushPayload[] = [];
  const buffer = createMediaGroupBuffer((payload) => {
    flushed.push(payload);
  });

  buffer.enqueue({
    mediaGroupId: "album-2",
    turnCtx: fakeTurnCtx(3, 30),
    context: { chatId: 3, replyToMessageId: 30 },
    item: { bytes: new Uint8Array([9]), fileName: "z.jpg" },
  });

  buffer.flushPendingForConversation({ chatId: 3 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(flushed.length, 1);
  assertEquals(flushed[0]?.items.length, 1);
  buffer.dispose();
});

Deno.test("media group buffer isolates albums by topic in one chat", async () => {
  const flushed: AlbumFlushPayload[] = [];
  const buffer = createMediaGroupBuffer((payload) => {
    flushed.push(payload);
  });

  buffer.enqueue({
    mediaGroupId: "album-same-chat",
    turnCtx: fakeTurnCtx(4, 40, 10),
    context: { chatId: 4, threadId: 10, replyToMessageId: 40 },
    item: { bytes: new Uint8Array([1]), fileName: "topic-a.jpg" },
  });
  buffer.enqueue({
    mediaGroupId: "album-same-chat",
    turnCtx: fakeTurnCtx(4, 41, 20),
    context: { chatId: 4, threadId: 20, replyToMessageId: 41 },
    item: { bytes: new Uint8Array([2]), fileName: "topic-b.jpg" },
  });

  buffer.flushPendingForConversation({ chatId: 4, threadId: 10 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(flushed.length, 1);
  assertEquals(flushed[0]?.context.threadId, 10);
  assertEquals(flushed[0]?.items[0]?.fileName, "topic-a.jpg");

  buffer.dispose();
});
