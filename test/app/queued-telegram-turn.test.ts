import { ChatMessage, type ChatMessageData, type Tool } from "@lmstudio/sdk";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

import { runQueuedTelegramTurn } from "../../src/app/queued-telegram-turn.ts";
import {
  type ContextSummaryPort,
  KvKernelStore,
  type LeasedWorkItem,
  type ModelTurnOutput,
  type ModelTurnPort,
  type ModelTurnRequest,
  SessionContextEngine,
} from "../../src/core/mod.ts";
import type { TelegramCapabilityTurnContext } from "../../src/telegram/capability-prompt.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

class FakeModelTurnPort implements ModelTurnPort, ContextSummaryPort {
  output: ModelTurnOutput = {
    persistedMessages: [rawMessage("assistant", "live.reply")],
    replyTexts: ["live.reply"],
  };
  run: (request: ModelTurnRequest) => Promise<ModelTurnOutput> = () => Promise.resolve(this.output);

  countTokens(messages: ChatMessageData[]): Promise<number[]> {
    return Promise.resolve(messages.map(() => 1));
  }

  summarize(): Promise<string> {
    return Promise.resolve("summary");
  }
}

class RecordingPromptPort {
  readonly calls: string[] = [];
  turnSignal: AbortSignal | undefined;

  setTurnContext(input: { ctx: TelegramCapabilityTurnContext; signal: AbortSignal }): void {
    this.calls.push("setTurnContext");
    this.turnSignal = input.signal;
  }

  clearTurnContext(): void {
    this.calls.push("clearTurnContext");
  }

  abortPending(): void {
    this.calls.push("abortPending");
  }
}

class RecordingActiveTurns {
  activeId: string | undefined;
  actController: AbortController | undefined;
  cleared = false;

  setActiveTurn(input: {
    id: string;
    actController: AbortController;
    approvalController: AbortController;
  }): () => void {
    this.activeId = input.id;
    this.actController = input.actController;
    return () => {
      this.cleared = true;
    };
  }
}

const fakeCtx: TelegramCapabilityTurnContext = {
  config: { adminId: 1, isAdmin: true },
  reply: () => Promise.resolve({ message_id: 1 }),
};

interface Harness {
  events: KvKernelStore;
  queue: KvKernelStore;
  model: FakeModelTurnPort;
  work: LeasedWorkItem;
  sent: { chatId: number; text: string }[];
  prompts: RecordingPromptPort;
  brokerPrompts: RecordingPromptPort;
  activeTurns: RecordingActiveTurns;
  turnIds: string[];
  run(options?: {
    signal?: AbortSignal;
    cancelReason?: string;
    onActError?: (error: unknown) => Promise<void>;
    onFinally?: () => Promise<void>;
  }): Promise<void>;
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    const submitted = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: {
        input: { message: rawMessage("user", "queued hello") },
        telegram: { chatId: 123, replyToMessageId: 7 },
      },
    });
    const work = await queue.lease(submitted.id, { ownerId: "host-a", kinds: ["user_turn"] });
    assert(work);

    const sent: { chatId: number; text: string }[] = [];
    const prompts = new RecordingPromptPort();
    const brokerPrompts = new RecordingPromptPort();
    const activeTurns = new RecordingActiveTurns();
    const turnIds: string[] = [];

    await fn({
      events,
      queue,
      model,
      work,
      sent,
      prompts,
      brokerPrompts,
      activeTurns,
      turnIds,
      run: (options) =>
        runQueuedTelegramTurn({
          work,
          signal: options?.signal ?? new AbortController().signal,
          ctx: fakeCtx,
          events,
          queue,
          context: new SessionContextEngine({ events, model, summary: model, maxContextLength: 100 }),
          modelAct: model,
          workspaceSystemPrompt: "system",
          sendApi: {
            sendMessage: (chatId, text) => {
              sent.push({ chatId, text });
              return Promise.resolve({ ok: true });
            },
          },
          activeTurns,
          capabilityPrompts: prompts,
          brokerPermissionPrompts: brokerPrompts,
          setActiveTurnId: (id) => {
            turnIds.push(id);
          },
          clearActiveTurnId: () => {
            turnIds.push("no-active-turn");
          },
          cancelReason: options?.cancelReason,
          onActError: options?.onActError,
          onFinally: options?.onFinally,
          runSessionWork: async (runAct) => {
            await runAct({
              userMessage: rawMessage("user", "prepared hello"),
              tools: [] as Tool[],
              fallbackText: "No reply.",
              startedLog: "started",
              finishedLog: (count) => `finished ${count}`,
            });
          },
        }),
    });
  } finally {
    kv.close();
  }
}

Deno.test("runQueuedTelegramTurn completes work and clears turn state", async () => {
  await withHarness(async (harness) => {
    let finallyRan = false;
    await harness.run({
      onFinally: () => {
        finallyRan = true;
        return Promise.resolve();
      },
    });

    assertEquals((await harness.queue.get(harness.work.id))?.status, "completed");
    assertEquals(harness.sent, [{ chatId: 123, text: "live\\.reply" }]);
    assertEquals(harness.activeTurns.activeId, harness.work.id);
    assert(harness.activeTurns.cleared);
    assertEquals(harness.turnIds, [harness.work.id, "no-active-turn"]);
    assert(finallyRan);
    assertEquals(harness.prompts.calls, ["setTurnContext", "clearTurnContext"]);
    assertEquals(harness.brokerPrompts.calls, []);
  });
});

Deno.test("runQueuedTelegramTurn fails work and aborts prompts on model error", async () => {
  await withHarness(async (harness) => {
    harness.model.run = () => Promise.reject(new Error("model exploded"));
    let observedError: unknown;

    await assertRejects(
      () =>
        harness.run({
          onActError: (error) => {
            observedError = error;
            return Promise.resolve();
          },
        }),
      Error,
      "model exploded",
    );

    const final = await harness.queue.get(harness.work.id);
    assertEquals(final?.status, "failed");
    assertEquals((observedError as Error).message, "model exploded");
    assertEquals(harness.prompts.calls, ["setTurnContext", "abortPending", "clearTurnContext"]);
    assertEquals(harness.brokerPrompts.calls, ["abortPending"]);
  });
});

Deno.test("runQueuedTelegramTurn cancels work when the turn is aborted mid-act", async () => {
  await withHarness(async (harness) => {
    harness.model.run = () => {
      harness.activeTurns.actController!.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    };

    await assertRejects(() => harness.run({ cancelReason: "Cron turn aborted." }), DOMException);

    const final = await harness.queue.get(harness.work.id);
    assertEquals(final?.status, "cancelled");
  });
});

Deno.test("runQueuedTelegramTurn releases work when shutdown aborts the turn", async () => {
  await withHarness(async (harness) => {
    const shutdown = new AbortController();
    harness.model.run = () => {
      shutdown.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    };

    await assertRejects(() => harness.run({ signal: shutdown.signal }), DOMException);

    const final = await harness.queue.get(harness.work.id);
    assertEquals(final?.status, "queued");
  });
});
