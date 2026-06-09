import { ChatMessage, type ChatMessageData } from "@lmstudio/sdk";
import { assertEquals } from "jsr:@std/assert@1";

import {
  KvKernelStore,
  KvSessionCatalog,
  type ModelTurnOutput,
  type ModelTurnPort,
  type ModelTurnRequest,
  SessionContextEngine,
  type SessionContextProjection,
  type SummaryCompactionInput,
} from "../../src/core/mod.ts";
import { type ContextSummaryPort, DurableAgentSessions } from "../../src/agent/context/session.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

class FakeModelTurnPort implements ModelTurnPort {
  readonly runRequests: ModelTurnRequest[] = [];
  readonly countTokenMessages: ChatMessageData[][] = [];

  run(request: ModelTurnRequest): Promise<ModelTurnOutput> {
    this.runRequests.push(request);
    return Promise.reject(new Error("DurableAgentSessions must not run model turns"));
  }

  countTokens(messages: ChatMessageData[]): Promise<number[]> {
    this.countTokenMessages.push(messages);
    return Promise.resolve(messages.map(defaultTokenCount));
  }
}

class FakeSummaryPort implements ContextSummaryPort {
  readonly inputs: SummaryCompactionInput[] = [];
  summary = "durable summary";

  summarize(input: SummaryCompactionInput): Promise<string> {
    this.inputs.push(input);
    return Promise.resolve(this.summary);
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

function rolesAndText(messages: readonly { role: string; content: readonly unknown[] }[]): [string, string][] {
  return messages.map((message) => [message.role, textOf(message)]);
}

function defaultTokenCount(message: ChatMessageData): number {
  if (message.role === "assistant") return 5;
  return 2;
}

async function withDurableSession(
  fn: (
    spec: {
      session: DurableAgentSessions;
      events: KvKernelStore;
      catalog: KvSessionCatalog;
      context: SessionContextEngine;
      model: FakeModelTurnPort;
      summary: FakeSummaryPort;
    },
  ) => Promise<void>,
  options?: { maxContextLength?: number },
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    const events = new KvKernelStore(kv);
    const catalog = new KvSessionCatalog(kv);
    const model = new FakeModelTurnPort();
    const summary = new FakeSummaryPort();
    const context = new SessionContextEngine({
      events,
      model,
      summary,
      maxContextLength: options?.maxContextLength ?? 100,
    });
    const session = new DurableAgentSessions({
      events,
      catalog,
      context,
      systemPrompt: "current system prompt",
      maxContextLength: options?.maxContextLength ?? 100,
    });
    await fn({ session, events, catalog, context, model, summary });
  } finally {
    kv.close();
  }
}

Deno.test("DurableAgentSessions refreshes status from projected v4 events without running model turns", async () => {
  await withDurableSession(async ({ session, events, model }) => {
    const saved = await session.save();
    await events.appendMany([
      {
        category: "turn.input",
        workId: "work-1",
        sessionId: saved.id,
        payload: { message: rawMessage("user", "hello") },
      },
      {
        category: "model.message",
        workId: "work-1",
        sessionId: saved.id,
        payload: { message: rawMessage("assistant", "reply") },
      },
    ]);

    const status = await session.status({ refresh: true });

    assertEquals(status.id, saved.id);
    assertEquals(status.messageCount, 3);
    assertEquals(status.tokenCount, 9);
    assertEquals(model.runRequests.length, 0);
    assertEquals(rolesAndText(model.countTokenMessages.at(-1) ?? []), [
      ["system", "current system prompt"],
      ["user", "hello"],
      ["assistant", "reply"],
    ]);
  });
});

Deno.test("DurableAgentSessions saves, renames, lists, and loads through the v4 catalog", async () => {
  await withDurableSession(async ({ session, catalog }) => {
    await session.rename("alpha");
    const saved = await session.save();
    assertEquals(saved.persisted, true);
    assertEquals(saved.name, "alpha");

    const listed = await session.list();
    assertEquals(listed, [{
      id: saved.id,
      createdAt: listed[0]?.createdAt ?? "",
      name: "alpha",
    }]);
    assertEquals((await catalog.resolve("alpha")).id, saved.id);

    session.new();
    const loaded = await session.load("alpha");
    assertEquals(loaded.id, saved.id);
    assertEquals(loaded.name, "alpha");
  });
});

Deno.test("DurableAgentSessions manual compaction appends a v4 compaction event", async () => {
  await withDurableSession(async ({ session, events, context, summary }) => {
    const saved = await session.save();
    await events.append({
      category: "turn.input",
      workId: "work-1",
      sessionId: saved.id,
      payload: { message: rawMessage("user", "remember this") },
    });

    const result = await session.compact({ instructions: "keep the goal" });
    const projection: SessionContextProjection = await context.project({
      sessionId: session.current.id,
      baseSystemPrompt: "current system prompt",
    });

    assertEquals(result.compacted, true);
    assertEquals(summary.inputs[0]?.instructions, "keep the goal");
    assertEquals(projection.compactionSummary, "durable summary");
    assertEquals(projection.messages, []);
  });
});

Deno.test("DurableAgentSessions fork creates catalog metadata and preserves projected history", async () => {
  await withDurableSession(async ({ session, events, context }) => {
    await session.rename("source");
    const saved = await session.save();
    await events.appendMany([
      {
        category: "turn.input",
        workId: "work-1",
        sessionId: saved.id,
        payload: { message: rawMessage("user", "hello") },
      },
      {
        category: "model.message",
        workId: "work-1",
        sessionId: saved.id,
        payload: { message: rawMessage("assistant", "reply") },
      },
    ]);

    const forked = await session.fork();
    const projection = await context.project({
      sessionId: forked.to.id,
      baseSystemPrompt: "current system prompt",
    });

    assertEquals(forked.from.name, "source");
    assertEquals(forked.to.name, undefined);
    assertEquals(rolesAndText(projection.messages), [
      ["user", "hello"],
      ["assistant", "reply"],
    ]);
  });
});
