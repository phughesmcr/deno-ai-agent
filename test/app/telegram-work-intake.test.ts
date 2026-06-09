import type { ChatMessageData } from "@lmstudio/sdk";
import { assert, assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1";

import type { DurableUserImage } from "../../src/agent/user-turn.ts";
import {
  type CancelTelegramConversationRequest,
  type SubmitTelegramCronRunRequest,
  TelegramWorkIntake,
} from "../../src/app/telegram-work-intake.ts";
import { cronRunWorkPayload, type QueuedDurableImage, userTurnWorkPayload } from "../../src/app/work-payload.ts";
import { EgressOutbox, type WorkItem, type WorkQueue } from "../../src/core/mod.ts";
import type { CronJob, CronJobRunnerResult, CronJobStore } from "../../src/cron/mod.ts";
import type { TelegramReplyOptions } from "../../src/telegram/model-reply.ts";
import type { TelegramSessionCoordinator } from "../../src/telegram/session-coordinator.ts";
import type { TelegramContext } from "../../src/telegram/telegram.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

interface ReplyRecord {
  text: string;
  options?: Record<string, unknown>;
}

interface SentMessage {
  chatId: number;
  text: string;
  options?: TelegramReplyOptions;
}

const job: CronJob = {
  id: "cron-a",
  chatId: 123,
  threadId: 99,
  prompt: "Check Gmail and summarize actions.",
  schedule: {
    kind: "recurring",
    scheduleText: "Every morning at 8am",
    timezone: "Europe/London",
    cronExpression: "0 8 * * *",
    recurrence: { kind: "daily", hour: 8, minute: 0 },
  },
  nextRunAt: "2026-06-06T07:00:00.000Z",
  enabled: true,
  sessionMode: "fresh",
  permissionProfile: { toolRules: [], brokerRules: [] },
  createdAt: "2026-06-05T12:00:00.000Z",
  updatedAt: "2026-06-05T12:00:00.000Z",
  topicName: "Cron: daily",
};

const message = {
  role: "user",
  content: [{ type: "text", text: "hello" }],
} as ChatMessageData;

function textOf(message: ChatMessageData): string {
  return message.content.flatMap((part) => {
    if (part === null || typeof part !== "object") return [];
    if (!("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") return [];
    return [part.text];
  }).join("");
}

class RecordingQueue implements WorkQueue {
  failSubmit: Error | undefined;
  private readonly _queue: MemoryKernelStore;
  private readonly _records: string[];

  constructor(queue: MemoryKernelStore, records: string[]) {
    this._queue = queue;
    this._records = records;
  }

  submit(input: Parameters<WorkQueue["submit"]>[0]): Promise<WorkItem> {
    this._records.push(`submit:${input.kind}`);
    if (this.failSubmit) return Promise.reject(this.failSubmit);
    return this._queue.submit(input);
  }

  get(id: string): Promise<WorkItem | null> {
    return this._queue.get(id);
  }

  lease(id: string, options: Parameters<WorkQueue["lease"]>[1]): ReturnType<WorkQueue["lease"]> {
    return this._queue.lease(id, options);
  }

  leaseNext(options: Parameters<WorkQueue["leaseNext"]>[0]): ReturnType<WorkQueue["leaseNext"]> {
    return this._queue.leaseNext(options);
  }

  complete(id: string, options: Parameters<WorkQueue["complete"]>[1]): Promise<void> {
    return this._queue.complete(id, options);
  }

  release(id: string, options: Parameters<WorkQueue["release"]>[1]): Promise<void> {
    return this._queue.release(id, options);
  }

  fail(id: string, options: Parameters<WorkQueue["fail"]>[1]): Promise<void> {
    return this._queue.fail(id, options);
  }

  cancel(id: string, options: Parameters<WorkQueue["cancel"]>[1]): Promise<void> {
    return this._queue.cancel(id, options);
  }

  recoverInterruptedWork(
    options: Parameters<WorkQueue["recoverInterruptedWork"]>[0],
  ): ReturnType<WorkQueue["recoverInterruptedWork"]> {
    return this._queue.recoverInterruptedWork(options);
  }

  listWork(options?: Parameters<WorkQueue["listWork"]>[0]): ReturnType<WorkQueue["listWork"]> {
    return this._queue.listWork(options);
  }
}

class RecordingImageStore {
  readonly deleted: QueuedDurableImage[][] = [];
  readonly stored: DurableUserImage[][] = [];
  refs: QueuedDurableImage[] = [{ imageId: "image-1", fileName: "photo.png", chunkCount: 1 }];
  private readonly _records: string[];

  constructor(records: string[]) {
    this._records = records;
  }

  putImages(images: readonly DurableUserImage[]): Promise<QueuedDurableImage[]> {
    this._records.push("putImages");
    this.stored.push([...images]);
    return Promise.resolve([...this.refs]);
  }

  deleteImages(refs: readonly QueuedDurableImage[]): Promise<void> {
    this._records.push("deleteImages");
    this.deleted.push([...refs]);
    return Promise.resolve();
  }
}

class RecordingTelegramApi {
  failSend = false;
  readonly messages: SentMessage[] = [];
  private readonly _records: string[];

  constructor(records: string[]) {
    this._records = records;
  }

  sendMessage(chatId: number, text: string, options?: TelegramReplyOptions): Promise<unknown> {
    this._records.push(`send:${text}`);
    this.messages.push({ chatId, text, ...(options !== undefined ? { options } : {}) });
    if (this.failSend) return Promise.reject(new Error("telegram send failed"));
    return Promise.resolve({ ok: true });
  }
}

class RecordingTypingApi {
  private readonly _records: string[];

  constructor(records: string[]) {
    this._records = records;
  }

  sendChatAction(
    chatId: number,
    action: "typing",
    options?: { message_thread_id?: number },
  ): Promise<unknown> {
    this._records.push(
      `typing:${chatId}:${action}${options?.message_thread_id === undefined ? "" : `:${options.message_thread_id}`}`,
    );
    return Promise.resolve({ ok: true });
  }
}

class RecordingSessions {
  readonly refs: unknown[] = [];
  replaced: unknown[] = [];

  withConversation<T>(ref: unknown, operation: () => Promise<T> | T): Promise<T> {
    this.refs.push(ref);
    return Promise.resolve().then(operation);
  }

  replaceWithNew(ref: unknown): Promise<{ id: string }> {
    this.replaced.push(ref);
    return Promise.resolve({ id: "fresh-session" });
  }
}

function telegramContext(options: {
  records: string[];
  chatId?: number;
  threadId?: number;
  messageId?: number;
  replyThrows?: boolean;
}): { ctx: TelegramContext; replies: ReplyRecord[] } {
  const chatId = options.chatId ?? 123;
  const replies: ReplyRecord[] = [];
  const ctx = {
    chat: { id: chatId },
    message: {
      chat: { id: chatId },
      message_id: options.messageId ?? 7,
      ...(options.threadId !== undefined ? { message_thread_id: options.threadId } : {}),
    },
    update: { update_id: 33 },
    api: { sendMessage: () => Promise.resolve({ ok: true }) },
    reply: (text: string, replyOptions?: Record<string, unknown>) => {
      options.records.push(`reply:${text}`);
      replies.push({ text, ...(replyOptions !== undefined ? { options: replyOptions } : {}) });
      if (options.replyThrows) return Promise.reject(new Error("ack failed"));
      return Promise.resolve({ ok: true });
    },
  } as unknown as TelegramContext;
  return { ctx, replies };
}

function createHarness(options?: { withTyping?: boolean }): {
  events: MemoryKernelStore;
  queue: RecordingQueue;
  imageStore: RecordingImageStore;
  records: string[];
  telegramApi: RecordingTelegramApi;
  typingApi?: RecordingTypingApi;
  intake: TelegramWorkIntake;
} {
  const records: string[] = [];
  const events = new MemoryKernelStore();
  const queue = new RecordingQueue(events, records);
  const imageStore = new RecordingImageStore(records);
  const telegramApi = new RecordingTelegramApi(records);
  const typingApi = options?.withTyping ? new RecordingTypingApi(records) : undefined;
  const typingController = new AbortController();
  const intake = new TelegramWorkIntake({
    queue,
    events,
    egressOutbox: new EgressOutbox(events),
    imageStore,
    capabilityLedger: {
      recordDecision: (input) =>
        Promise.resolve({
          id: "decision-1",
          sessionId: input.sessionId,
          capability: input.capability,
          decision: input.decision,
          scope: input.scope,
          reason: input.reason,
          createdAt: "2026-06-06T07:00:03.000Z",
        }),
    },
    cronStore: {} as CronJobStore,
    sessions: new RecordingSessions() as unknown as TelegramSessionCoordinator,
    telegramApi,
    ...(typingApi ? { typingApi, typingSignal: typingController.signal } : {}),
    wakeQueue: () => records.push("wake"),
    currentSessionId: () => "session-1",
  });
  return { events, queue, imageStore, records, telegramApi, typingApi, intake };
}

function cronRequest(): SubmitTelegramCronRunRequest {
  return {
    job,
    sessionId: "session-1",
    dispatchedAt: new Date("2026-06-06T07:00:03.000Z"),
  };
}

Deno.test("TelegramWorkIntake persists user work before sending the Telegram ack", async () => {
  const { queue, records, intake } = createHarness();
  const { ctx, replies } = telegramContext({ records, threadId: 9 });

  const result = await intake.submitUserTurn({
    ctx,
    input: { text: "queued hello" },
    replyToMessageId: 7,
    updateId: 33,
    sessionId: "session-1",
  });

  assertEquals(records, ["submit:user_turn", "reply:Working on it...", "wake"]);
  assertEquals(replies, [{
    text: "Working on it...",
    options: { message_thread_id: 9 },
  }]);
  assertEquals(result.sessionId, "session-1");
  const work = await queue.get(result.workId);
  assert(work);
  assertEquals(work.status, "queued");
  assertEquals(userTurnWorkPayload(work.payload).telegram, {
    chatId: 123,
    threadId: 9,
    replyToMessageId: 7,
    updateId: 33,
  });
});

Deno.test("TelegramWorkIntake wakes the queue after the ack attempt even when ack throws", async () => {
  const { records, intake } = createHarness();
  const { ctx } = telegramContext({ records, replyThrows: true });

  await intake.submitUserTurn({
    ctx,
    input: { text: "ack fails" },
    replyToMessageId: 7,
    updateId: 33,
    sessionId: "session-1",
  });

  assertEquals(records, ["submit:user_turn", "reply:Working on it...", "wake"]);
});

Deno.test("TelegramWorkIntake stores durable images before submit and includes refs in the work payload", async () => {
  const { queue, imageStore, records, intake } = createHarness();
  const durableImages = [{ fileName: "photo.png", base64: "aGVsbG8=" }];
  const { ctx } = telegramContext({ records });

  const result = await intake.submitUserTurn({
    ctx,
    input: { text: "describe this", durableImages },
    replyToMessageId: 7,
    updateId: 33,
    sessionId: "session-1",
  });

  assertEquals(records, ["putImages", "submit:user_turn", "reply:Working on it...", "wake"]);
  assertEquals(imageStore.stored, [durableImages]);
  const work = await queue.get(result.workId);
  assert(work);
  const payload = userTurnWorkPayload(work.payload);
  assertEquals(payload.input.durableImages, imageStore.refs);
  assertEquals(textOf(payload.input.message), "describe this");
});

Deno.test("TelegramWorkIntake deletes durable images when queue submission fails", async () => {
  const { queue, imageStore, records, intake } = createHarness();
  queue.failSubmit = new Error("queue unavailable");
  const { ctx } = telegramContext({ records });

  await assertRejects(
    () =>
      intake.submitUserTurn({
        ctx,
        input: { text: "describe this", durableImages: [{ fileName: "photo.png", base64: "aGVsbG8=" }] },
        replyToMessageId: 7,
        updateId: 33,
        sessionId: "session-1",
      }),
    Error,
    "queue unavailable",
  );

  assertEquals(records, ["putImages", "submit:user_turn", "deleteImages"]);
  assertEquals(imageStore.deleted, [imageStore.refs]);
});

Deno.test("TelegramWorkIntake starts typing on submit and stops when live context is deleted", async () => {
  const { records, intake } = createHarness({ withTyping: true });
  const { ctx } = telegramContext({ records, threadId: 9 });

  const result = await intake.submitUserTurn({
    ctx,
    input: { text: "typing please" },
    replyToMessageId: 7,
    updateId: 33,
    sessionId: "session-1",
  });

  assert(records.includes("typing:123:typing:9"));
  intake.ensureTyping(result.workId, { chatId: 123, threadId: 9 });
  assertEquals(records.filter((record) => record.startsWith("typing:")).length, 1);
  intake.deleteLiveContext(result.workId);
  assertEquals(intake.liveContext(result.workId), undefined);
});

Deno.test("TelegramWorkIntake stores and removes live Telegram contexts by work id", async () => {
  const { records, intake } = createHarness();
  const { ctx } = telegramContext({ records });

  const result = await intake.submitUserTurn({
    ctx,
    input: { text: "live context" },
    replyToMessageId: 7,
    updateId: 33,
    sessionId: "session-1",
  });

  assertStrictEquals(intake.liveContext(result.workId), ctx);
  intake.deleteLiveContext(result.workId);
  assertEquals(intake.liveContext(result.workId), undefined);
});

Deno.test("TelegramWorkIntake submits cron work before cron start egress", async () => {
  const { queue, records, intake } = createHarness();

  const result = await intake.submitCronRun(cronRequest());

  assertEquals(result, { status: "submitted", workId: "cron:cron-a:2026-06-06T07:00:00.000Z" });
  if (result.status !== "submitted") throw new Error("Expected cron work submission");
  assertEquals(records, [
    "submit:cron_run",
    `send:Cron job ${job.id} started.\n${job.prompt}`,
    "wake",
  ]);
  const work = await queue.get(result.workId);
  assert(work);
  assertEquals(cronRunWorkPayload(work.payload).telegram, {
    chatId: 123,
    threadId: 99,
    cronJobId: "cron-a",
  });
});

Deno.test("TelegramWorkIntake absorbs cron start egress failure after durable submission", async () => {
  const { events, queue, records, telegramApi, intake } = createHarness();
  telegramApi.failSend = true;

  const result = await intake.submitCronRun(cronRequest()) as CronJobRunnerResult & { workId: string };

  assertEquals(result, { status: "submitted", workId: "cron:cron-a:2026-06-06T07:00:00.000Z" });
  assertEquals(records, [
    "submit:cron_run",
    `send:Cron job ${job.id} started.\n${job.prompt}`,
    "wake",
  ]);
  assertEquals((await queue.get(result.workId))?.status, "queued");
  assertEquals((await events.listByWork(result.workId)).map((event) => event.category), [
    "work.created",
    "egress.queued",
  ]);
});

Deno.test("TelegramWorkIntake cancellation only cancels queued matching turns and deletes their images", async () => {
  const { queue, imageStore, records, intake } = createHarness();
  const matching = await queue.submit({
    id: "queued-matching",
    kind: "user_turn",
    sessionId: "session-1",
    payload: {
      input: { message, durableImages: imageStore.refs },
      telegram: { chatId: 1, threadId: 2, replyToMessageId: 10, updateId: 20 },
    },
  });
  const active = await queue.submit({
    id: "active-matching",
    kind: "user_turn",
    sessionId: "session-1",
    availableAt: new Date("2026-06-08T09:59:00.000Z"),
    payload: {
      input: { message, durableImages: [{ imageId: "active-image", fileName: "active.png", chunkCount: 1 }] },
      telegram: { chatId: 1, threadId: 2, replyToMessageId: 11, updateId: 21 },
    },
  });
  const activeLease = await queue.lease(active.id, {
    ownerId: "host-a",
    kinds: ["user_turn"],
    now: new Date("2026-06-08T10:00:00.000Z"),
  });
  assert(activeLease);
  const otherTopic = await queue.submit({
    id: "queued-other-topic",
    kind: "user_turn",
    sessionId: "session-1",
    payload: {
      input: { message, durableImages: [{ imageId: "other-image", fileName: "other.png", chunkCount: 1 }] },
      telegram: { chatId: 1, threadId: 3, replyToMessageId: 12, updateId: 22 },
    },
  });

  const result = await intake.cancelConversation({
    target: { chatId: 1, threadId: 2 },
    reason: "Turn aborted.",
  });

  assertEquals(result.cancelledWorkIds, [matching.id]);
  assertEquals((await queue.get(matching.id))?.status, "cancelled");
  assertEquals((await queue.get(active.id))?.status, "leased");
  assertEquals((await queue.get(otherTopic.id))?.status, "queued");
  assertEquals(imageStore.deleted, [imageStore.refs]);
  assertEquals(records.filter((record) => record === "deleteImages"), ["deleteImages"]);
});

Deno.test("TelegramWorkIntake cancellation sends the existing abort reply text", async () => {
  const { queue, records, intake } = createHarness();
  const { ctx, replies } = telegramContext({ records, chatId: 1, threadId: 2, messageId: 90 });
  await queue.submit({
    id: "queued-matching",
    kind: "user_turn",
    sessionId: "session-1",
    payload: {
      input: { message },
      telegram: { chatId: 1, threadId: 2, replyToMessageId: 10, updateId: 20 },
    },
  });

  const request: CancelTelegramConversationRequest = {
    target: { chatId: 1, threadId: 2 },
    reason: "Turn aborted.",
    reply: { ctx, abortedActiveTurn: true },
  };
  await intake.cancelConversation(request);

  assertEquals(replies, [{
    text: "Aborted current turn and cancelled 1 queued turn.",
    options: { message_thread_id: 2 },
  }]);
});
