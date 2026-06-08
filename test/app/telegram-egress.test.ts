import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  drainTelegramEgressOutbox,
  queueAndSendTelegramEgress,
  type TelegramEgressApi,
} from "../../src/app/telegram-egress.ts";
import { EgressOutbox, MemoryEventStore } from "../../src/core/mod.ts";
import type { TelegramReplyOptions } from "../../src/telegram/model-reply.ts";

interface SentMessage {
  chatId: number;
  text: string;
  options?: TelegramReplyOptions;
}

class RecordingTelegramApi implements TelegramEgressApi {
  readonly messages: SentMessage[] = [];
  fail = false;
  failMessage = "telegram unavailable";

  sendMessage(chatId: number, text: string, options?: TelegramReplyOptions): Promise<unknown> {
    if (this.fail) return Promise.reject(new Error(this.failMessage));
    this.messages.push({ chatId, text, ...(options !== undefined ? { options } : {}) });
    return Promise.resolve({ ok: true });
  }
}

Deno.test("drainTelegramEgressOutbox sends pending replies and marks them sent", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();
  await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "egress-1",
    target: { chatId: 123, threadId: 9, replyToMessageId: 42, updateId: 99 },
    replies: ["hello.world"],
  });

  const result = await drainTelegramEgressOutbox({ outbox, api });

  assertEquals(result, { pending: 1, sent: 1, skipped: 0, failed: 0, dropped: 0 });
  assertEquals(api.messages, [{
    chatId: 123,
    text: "hello\\.world",
    options: {
      message_thread_id: 9,
      parse_mode: "MarkdownV2",
      reply_parameters: { message_id: 42 },
    },
  }]);
  assertEquals(await outbox.listPending(), []);
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
    "egress.queued",
    "egress.sent",
  ]);
});

Deno.test("queueAndSendTelegramEgress queues live replies before sending and marks them sent", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();

  await queueAndSendTelegramEgress({
    outbox,
    api,
    workId: "work-1",
    sessionId: "session-1",
    target: { chatId: 123, threadId: 9, replyToMessageId: 42 },
    replies: ["live.reply"],
    egressId: "egress-1",
  });

  assertEquals(api.messages, [{
    chatId: 123,
    text: "live\\.reply",
    options: {
      message_thread_id: 9,
      parse_mode: "MarkdownV2",
      reply_parameters: { message_id: 42 },
    },
  }]);
  assertEquals(await outbox.listPending(), []);
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
    "egress.queued",
    "egress.sent",
  ]);
});

Deno.test("queueAndSendTelegramEgress can send into a Telegram topic without reply parameters", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();

  await queueAndSendTelegramEgress({
    outbox,
    api,
    workId: "work-1",
    sessionId: "session-1",
    target: { chatId: 123, threadId: 9, cronJobId: "cron-a" },
    replies: ["cron.started"],
    egressId: "egress-1",
  });

  assertEquals(api.messages, [{
    chatId: 123,
    text: "cron\\.started",
    options: {
      message_thread_id: 9,
      parse_mode: "MarkdownV2",
    },
  }]);
  assertEquals(await outbox.listPending(), []);
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
    "egress.queued",
    "egress.sent",
  ]);
});

Deno.test("queueAndSendTelegramEgress leaves failed live sends pending", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();
  api.fail = true;

  await assertRejects(
    () =>
      queueAndSendTelegramEgress({
        outbox,
        api,
        workId: "work-1",
        sessionId: "session-1",
        target: { chatId: 123, replyToMessageId: 42 },
        replies: ["live"],
        egressId: "egress-1",
      }),
    Error,
    "telegram unavailable",
  );

  assertEquals((await outbox.listPending()).map((pending) => pending.payload.egressId), ["egress-1"]);
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), ["egress.queued"]);
});

Deno.test("drainTelegramEgressOutbox sends fallback text when no replies exist", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();
  await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "egress-1",
    target: { chatId: 123, threadId: 9, replyToMessageId: 42 },
    replies: [],
    fallbackText: "No reply.",
  });

  const result = await drainTelegramEgressOutbox({ outbox, api });

  assertEquals(result, { pending: 1, sent: 1, skipped: 0, failed: 0, dropped: 0 });
  assertEquals(api.messages, [{
    chatId: 123,
    text: "No reply.",
    options: { message_thread_id: 9 },
  }]);
  assertEquals(await outbox.listPending(), []);
});

Deno.test("drainTelegramEgressOutbox leaves failed sends pending", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();
  api.fail = true;
  await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "egress-1",
    target: { chatId: 123, replyToMessageId: 42 },
    replies: ["hello"],
  });

  const result = await drainTelegramEgressOutbox({ outbox, api });

  assertEquals(result, { pending: 1, sent: 0, skipped: 0, failed: 1, dropped: 0 });
  assertEquals(api.messages, []);
  assertEquals((await outbox.listPending()).map((pending) => pending.payload.egressId), ["egress-1"]);
});

Deno.test("queueAndSendTelegramEgress drops permanent live send failures", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();
  api.fail = true;
  api.failMessage = "Call to 'sendMessage' failed! (400: Bad Request: message thread not found)";

  await queueAndSendTelegramEgress({
    outbox,
    api,
    workId: "work-1",
    sessionId: "session-1",
    target: { chatId: 123, threadId: 999 },
    replies: ["live"],
    egressId: "egress-1",
  });

  assertEquals(await outbox.listPending(), []);
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
    "egress.queued",
    "egress.dropped",
  ]);
});

Deno.test("drainTelegramEgressOutbox drops permanent Telegram failures", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();
  api.fail = true;
  api.failMessage = "Call to 'sendMessage' failed! (400: Bad Request: message thread not found)";
  await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "egress-1",
    target: { chatId: 123, threadId: 999 },
    replies: ["hello"],
  });

  const result = await drainTelegramEgressOutbox({ outbox, api });

  assertEquals(result, { pending: 1, sent: 0, skipped: 0, failed: 0, dropped: 1 });
  assertEquals(api.messages, []);
  assertEquals(await outbox.listPending(), []);
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
    "egress.queued",
    "egress.dropped",
  ]);
});

Deno.test("drainTelegramEgressOutbox drops invalid Telegram targets", async () => {
  const events = new MemoryEventStore();
  const outbox = new EgressOutbox(events);
  const api = new RecordingTelegramApi();
  await outbox.queue({
    workId: "work-1",
    sessionId: "session-1",
    egressId: "egress-1",
    target: { chatId: "123", replyToMessageId: 42 },
    replies: ["hello"],
  });

  const result = await drainTelegramEgressOutbox({ outbox, api });

  assertEquals(result, { pending: 1, sent: 0, skipped: 1, failed: 0, dropped: 1 });
  assertEquals(api.messages, []);
  assertEquals(await outbox.listPending(), []);
});
