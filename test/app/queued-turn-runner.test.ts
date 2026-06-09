import { ChatMessage, type ChatMessageData, type Tool } from "@lmstudio/sdk";
import { assert, assertEquals } from "jsr:@std/assert@1";

import { createTelegramTurnEgressPort, runQueuedPreparedTurn } from "../../src/app/queued-turn-runner.ts";
import {
  type ContextSummaryPort,
  KvKernelStore,
  type ModelTurnOutput,
  type ModelTurnPort,
  type ModelTurnRequest,
  SessionContextEngine,
} from "../../src/core/mod.ts";
import type { TelegramReplyOptions } from "../../src/telegram/model-reply.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

interface SentMessage {
  chatId: number;
  text: string;
  options?: TelegramReplyOptions;
}

class FakeModelTurnPort implements ModelTurnPort, ContextSummaryPort {
  readonly requests: ModelTurnRequest[] = [];
  output: ModelTurnOutput = {
    persistedMessages: [rawMessage("assistant", "live.reply")],
    replyTexts: ["live.reply"],
  };

  run(request: ModelTurnRequest): Promise<ModelTurnOutput> {
    this.requests.push(request);
    return Promise.resolve(this.output);
  }

  countTokens(messages: ChatMessageData[]): Promise<number[]> {
    return Promise.resolve(messages.map(() => 1));
  }

  summarize(): Promise<string> {
    return Promise.resolve("summary");
  }
}

class RecordingTelegramApi {
  readonly messages: SentMessage[] = [];

  sendMessage(chatId: number, text: string, options?: TelegramReplyOptions): Promise<unknown> {
    this.messages.push({ chatId, text, ...(options !== undefined ? { options } : {}) });
    return Promise.resolve({ ok: true });
  }
}

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

function textOf(message: { content: readonly unknown[] }): string {
  return message.content.flatMap((part) => {
    if (part === null || typeof part !== "object") return [];
    if (!("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") return [];
    return [part.text];
  }).join("");
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

Deno.test("runQueuedPreparedTurn drives queued Telegram work through TurnRunner", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    const api = new RecordingTelegramApi();
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: {
        input: { message: rawMessage("user", "queued hello") },
        telegram: { chatId: 123, threadId: 9, replyToMessageId: 7 },
      },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    const output = await runQueuedPreparedTurn({
      events,
      queue,
      context: new SessionContextEngine({ events, model, summary: model, maxContextLength: 100 }),
      egress: createTelegramTurnEgressPort(api),
      baseSystemPrompt: "system",
      work: leased,
      userMessage: rawMessage("user", "prepared hello"),
      tools: [] as Tool[],
      signal: new AbortController().signal,
      fallbackText: "No reply.",
    });

    assertEquals(output.replyTexts, ["live.reply"]);
    assertEquals(model.requests[0]?.messages.map((message) => [message.role, textOf(message)]), [
      ["user", "prepared hello"],
    ]);
    assertEquals(api.messages, [{
      chatId: 123,
      text: "live\\.reply",
      options: {
        message_thread_id: 9,
        parse_mode: "MarkdownV2",
        reply_parameters: { message_id: 7 },
      },
    }]);
    assertEquals((await queue.get(work.id))?.status, "completed");
    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "model.message",
      "egress.queued",
      "egress.sent",
      "work.completed",
    ]);
  });
});

Deno.test("runQueuedPreparedTurn sends fallback Telegram egress when there are no replies", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    model.output = {
      persistedMessages: [],
      replyTexts: [],
    };
    const api = new RecordingTelegramApi();
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: {
        input: { message: rawMessage("user", "quiet") },
        telegram: { chatId: 123, threadId: 9, replyToMessageId: 7 },
      },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await runQueuedPreparedTurn({
      events,
      queue,
      context: new SessionContextEngine({ events, model, summary: model, maxContextLength: 100 }),
      egress: createTelegramTurnEgressPort(api),
      baseSystemPrompt: "system",
      work: leased,
      userMessage: rawMessage("user", "quiet"),
      tools: [] as Tool[],
      signal: new AbortController().signal,
      fallbackText: "No reply.",
    });

    assertEquals(api.messages, [{
      chatId: 123,
      text: "No reply.",
      options: { message_thread_id: 9 },
    }]);
    const egress = (await events.listByWork(work.id)).find((event) => event.category === "egress.queued");
    assertEquals((egress?.payload as { replies?: unknown; fallbackText?: unknown }).replies, []);
    assertEquals((egress?.payload as { replies?: unknown; fallbackText?: unknown }).fallbackText, "No reply.");
  });
});
