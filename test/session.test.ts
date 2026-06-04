import { ChatMessage, type ChatMessageData, type Tool } from "@lmstudio/sdk";
import { assert } from "jsr:@std/assert@1/assert";
import { assertEquals } from "jsr:@std/assert@1/equals";
import type { SummaryCompactionInput } from "../src/agent/context/compactor.ts";
import { SessionStore } from "../src/agent/context/session-store.ts";
import {
  type ContextSummaryPort,
  type ModelActObserver,
  type ModelTurnOutput,
  type ModelTurnPort,
  type ModelTurnRequest,
  PersistentAgentSessions,
} from "../src/agent/context/session.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

class FakeModelTurnPort implements ModelTurnPort {
  readonly calls: ModelTurnRequest[] = [];
  readonly countTokenMessages: ChatMessageData[][] = [];
  outputs: ModelTurnOutput[] = [{
    persistedMessages: [rawMessage("assistant", "reply")],
    replyTexts: ["reply"],
    firstTokenMs: 12,
  }];

  run(request: ModelTurnRequest): Promise<ModelTurnOutput> {
    this.calls.push(request);
    return Promise.resolve(
      this.outputs.shift() ?? {
        persistedMessages: [rawMessage("assistant", "reply")],
        replyTexts: ["reply"],
      },
    );
  }

  countTokens(messages: ChatMessageData[]): Promise<number[]> {
    this.countTokenMessages.push(messages);
    return Promise.resolve(messages.map(defaultTokenCount));
  }
}

class FakeSummaryPort implements ContextSummaryPort {
  readonly inputs: SummaryCompactionInput[] = [];
  summary = "summary";

  summarize(input: SummaryCompactionInput): Promise<string> {
    this.inputs.push(input);
    return Promise.resolve(this.summary);
  }
}

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

function toolResultMessage(text: string): ChatMessageData {
  return {
    role: "tool",
    content: [{ type: "toolCallResult", content: text, toolCallId: "tool-call-1" }],
  } as ChatMessageData;
}

function imageMessage(text: string): ChatMessageData {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "file", fileType: "image", name: "diagram.png" },
    ],
  } as unknown as ChatMessageData;
}

function textOf(message: ChatMessageData): string {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

function defaultTokenCount(message: ChatMessageData): number {
  if (message.role === "assistant") return 5;
  return 2;
}

function rolesAndText(messages: ChatMessageData[]): [string, string][] {
  return messages.map((message) => [message.role, textOf(message)]);
}

function recordingObserver(events: string[]): ModelActObserver {
  return {
    onMessage: () => events.push("message"),
    onFirstToken: (roundIndex, ms) => events.push(`first:${roundIndex}:${typeof ms}`),
    onRoundStart: (roundIndex) => events.push(`round-start:${roundIndex}`),
    onRoundEnd: (roundIndex) => events.push(`round-end:${roundIndex}`),
    onToolCallRequestStart: (roundIndex, callId, toolCallId) => {
      events.push(`tool-start:${roundIndex}:${callId}:${toolCallId}`);
    },
    onToolCallRequestNameReceived: (callId, name) => events.push(`tool-name:${callId}:${name}`),
    onToolCallRequestEnd: (roundIndex, callId, name, isQueued) => {
      events.push(`tool-end:${roundIndex}:${callId}:${name}:${isQueued}`);
    },
    onToolCallRequestFailure: (callId, message) => events.push(`tool-failure:${callId}:${message}`),
    onToolCallRequestFinalized: (callId, name) => events.push(`tool-finalized:${callId}:${name}`),
    onToolCallRequestDequeued: (roundIndex, callId) => events.push(`tool-dequeued:${roundIndex}:${callId}`),
  };
}

function withDebugLogs(fn: () => Promise<void>): Promise<string[]> {
  const previousLevel = Deno.env.get("LOG_LEVEL");
  const lines: string[] = [];
  const decoder = new TextDecoder();
  const originalWriteSync = Deno.stderr.writeSync.bind(Deno.stderr);
  Deno.stderr.writeSync = (data: Uint8Array): number => {
    lines.push(...decoder.decode(data).trimEnd().split("\n").filter((line) => line.length > 0));
    return data.length;
  };
  Deno.env.set("LOG_LEVEL", "debug");

  return fn().then(
    () => lines,
    (error) => {
      throw error;
    },
  ).finally(() => {
    Deno.stderr.writeSync = originalWriteSync;
    if (previousLevel === undefined) {
      Deno.env.delete("LOG_LEVEL");
    } else {
      Deno.env.set("LOG_LEVEL", previousLevel);
    }
  });
}

async function withSession(
  fn: (
    spec: {
      session: PersistentAgentSessions;
      store: SessionStore;
      model: FakeModelTurnPort;
      summary: FakeSummaryPort;
    },
  ) => Promise<void>,
  options?: {
    reserveTokens?: number;
    keepRecentTokens?: number;
    maxContextLength?: number;
    systemPrompt?: string;
  },
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-session-" });
  try {
    const store = new SessionStore(dir);
    const model = new FakeModelTurnPort();
    const summary = new FakeSummaryPort();
    const session = new PersistentAgentSessions({
      store,
      model,
      summary,
      systemPrompt: options?.systemPrompt ?? "current system prompt",
      maxContextLength: options?.maxContextLength ?? 100,
      reserveTokens: options?.reserveTokens,
      keepRecentTokens: options?.keepRecentTokens,
    });
    await fn({ session, store, model, summary });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("PersistentAgentSessions appends user input, projects context, persists model output, and returns replies", async () => {
  await withSession(async ({ session, model, store }) => {
    model.outputs = [{
      persistedMessages: [
        rawMessage("assistant", "visible reply"),
        toolResultMessage("tool result"),
      ],
      replyTexts: ["raw visible reply"],
      firstTokenMs: 7,
    }];

    const result = await session.turn("hello", { tools: [], signal: new AbortController().signal });

    assertEquals(result.replyTexts, ["raw visible reply"]);
    assertEquals(result.firstTokenMs, 7);
    assertEquals(result.turnTokens, 7);
    assertEquals(result.compacted, false);
    assertEquals(result.totalTokens, 11);
    assertEquals(model.calls[0]?.systemPrompt, "current system prompt");
    assertEquals(rolesAndText(model.calls[0]?.messages ?? []), [["user", "hello"]]);

    const log = await store.read(session.current.id);
    assertEquals(log.entries.map((entry) => entry.type), ["message", "message", "message"]);
    assertEquals(log.entries.map((entry) => entry.type === "message" ? entry.message.role : entry.type), [
      "user",
      "assistant",
      "tool",
    ]);
  });
});

Deno.test("PersistentAgentSessions forwards tools, guardToolCall, signal, and observer to ModelTurnPort", async () => {
  await withSession(async ({ session, model }) => {
    const tools = [{ name: "fake-tool" }] as unknown as Tool[];
    const signal = new AbortController().signal;
    const guardToolCall = () => {};
    const events: string[] = [];
    const observer = recordingObserver(events);

    await session.turn("hello", { tools, guardToolCall, signal, observer });

    assertEquals(model.calls[0]?.tools, tools);
    assertEquals(model.calls[0]?.guardToolCall, guardToolCall);
    assertEquals(model.calls[0]?.signal, signal);
    assertEquals(model.calls[0]?.observer, observer);
  });
});

Deno.test("PersistentAgentSessions projects follow-up context with prior assistant, tool, and image file parts", async () => {
  await withSession(async ({ session, model, store }) => {
    const id = crypto.randomUUID();
    await store.create(id);
    await store.append(id, {
      type: "message",
      id: crypto.randomUUID(),
      createdAt: "2026-06-03T00:00:00.000Z",
      message: imageMessage("look"),
    });
    await session.load(id);
    model.outputs = [{
      persistedMessages: [rawMessage("assistant", "first reply"), toolResultMessage("tool result")],
      replyTexts: ["first reply"],
    }, {
      persistedMessages: [rawMessage("assistant", "second reply")],
      replyTexts: ["second reply"],
    }];

    await session.turn("first follow-up", { tools: [], signal: new AbortController().signal });
    await session.turn("second follow-up", { tools: [], signal: new AbortController().signal });

    const secondCallMessages = model.calls[1]?.messages ?? [];
    assertEquals(rolesAndText(secondCallMessages), [
      ["user", "look"],
      ["user", "first follow-up"],
      ["assistant", "first reply"],
      ["tool", ""],
      ["user", "second follow-up"],
    ]);
    assert(secondCallMessages[0]?.content.some((part) => part.type === "file" && part.fileType === "image"));
  });
});

Deno.test("PersistentAgentSessions manual compaction runs below budget and preserves instructions", async () => {
  await withSession(async ({ session, model, summary }) => {
    summary.summary = "manual summary";
    model.outputs = [
      { persistedMessages: [rawMessage("assistant", "first reply")], replyTexts: ["first reply"] },
      { persistedMessages: [rawMessage("assistant", "second reply")], replyTexts: ["second reply"] },
      { persistedMessages: [rawMessage("assistant", "after manual")], replyTexts: ["after manual"] },
    ];

    await session.turn("first", { tools: [], signal: new AbortController().signal });
    await session.turn("second", { tools: [], signal: new AbortController().signal });
    const result = await session.compact({ instructions: "manual checkpoint" });

    assertEquals(result.compacted, true);
    assertEquals(result.beforeTokens, 16);
    assertEquals(result.afterTokens, 4);
    assertEquals(summary.inputs[0]?.instructions, "manual checkpoint");
    assertEquals(summary.inputs[0]?.messages.map((message) => message.role), [
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    await session.turn("after compact", { tools: [], signal: new AbortController().signal });
    assertEquals(rolesAndText(model.calls[2]?.messages ?? []), [
      ["user", "[Earlier conversation summary]\nmanual summary"],
      ["user", "after compact"],
    ]);
  });
});

Deno.test("PersistentAgentSessions auto compaction appends a checkpoint and projects summary plus safe retained messages", async () => {
  await withSession(
    async ({ session, model, summary, store }) => {
      summary.summary = "summary";
      model.outputs = [
        { persistedMessages: [rawMessage("assistant", "reply")], replyTexts: ["reply"] },
        { persistedMessages: [rawMessage("assistant", "after compact")], replyTexts: ["after compact"] },
      ];

      const first = await session.turn("too much context", { tools: [], signal: new AbortController().signal });
      assertEquals(first.compacted, true);
      assertEquals(first.totalTokens, 9);
      assertEquals(summary.inputs[0]?.messages.map((message) => message.role), ["user"]);

      const log = await store.read(session.current.id);
      assertEquals(log.entries.at(-1)?.type, "compaction");

      await session.turn("after compact", { tools: [], signal: new AbortController().signal });
      assertEquals(rolesAndText(model.calls[1]?.messages ?? []), [
        ["user", "[Earlier conversation summary]\nsummary"],
        ["assistant", "reply"],
        ["user", "after compact"],
      ]);
    },
    { maxContextLength: 10, reserveTokens: 2, keepRecentTokens: 5 },
  );
});

Deno.test("PersistentAgentSessions derives compaction budgets from context length by default", async () => {
  await withSession(
    async ({ session, summary }) => {
      const first = await session.turn("one", { tools: [], signal: new AbortController().signal });
      const second = await session.turn("two", { tools: [], signal: new AbortController().signal });
      const third = await session.turn("three", { tools: [], signal: new AbortController().signal });

      assertEquals(first.compacted, false);
      assertEquals(second.compacted, false);
      assertEquals(third.compacted, true);
      assertEquals(third.totalTokens, 16);
      assertEquals(summary.inputs[0]?.messages.map((message) => message.role), ["user", "assistant", "user"]);
    },
    { maxContextLength: 24 },
  );
});

Deno.test("PersistentAgentSessions load, fork, new, rename, save, list, and status behavior", async () => {
  await withSession(async ({ session, store }) => {
    await session.rename("my-alias");
    await session.turn("hello", { tools: [], signal: new AbortController().signal });
    assertEquals((await store.readHeader(session.current.id)).name, "my-alias");

    const saved = await session.save();
    assertEquals(saved.existsOnDisk, true);
    assertEquals(saved.dirty, false);
    assertEquals((await session.list()).map((summary) => summary.name), ["my-alias"]);

    const { from, to } = await session.fork();
    assertEquals(from.name, "my-alias");
    assertEquals(to.name, undefined);
    assert(from.id !== to.id);

    const fresh = session.new();
    assertEquals(fresh.name, undefined);
    assertEquals(fresh.existsOnDisk, false);

    await session.load("my-alias");
    const loaded = await session.status();
    assertEquals(loaded.id, from.id);
    assertEquals(loaded.name, "my-alias");
  });
});

Deno.test("PersistentAgentSessions load reapplies the current prompt over saved prompt", async () => {
  await withSession(async ({ session, store, model }) => {
    const id = crypto.randomUUID();
    await store.create(id);
    await store.append(id, {
      type: "message",
      id: crypto.randomUUID(),
      createdAt: "2026-06-03T00:00:00.000Z",
      message: rawMessage("system", "old prompt"),
    });
    await store.append(id, {
      type: "message",
      id: crypto.randomUUID(),
      createdAt: "2026-06-03T00:00:00.000Z",
      message: rawMessage("user", "from disk"),
    });

    await session.load(id);
    await session.turn("after load", { tools: [], signal: new AbortController().signal });

    assertEquals(model.calls[0]?.systemPrompt, "current system prompt");
    assertEquals(rolesAndText(model.calls[0]?.messages ?? []), [
      ["user", "from disk"],
      ["user", "after load"],
    ]);
  });
});

Deno.test("PersistentAgentSessions debug append logs metadata without message text", async () => {
  await withSession(async ({ session, model }) => {
    model.outputs = [{
      persistedMessages: [rawMessage("assistant", "assistant secret")],
      replyTexts: ["assistant secret"],
    }];

    const logs = await withDebugLogs(async () => {
      await session.turn("user secret", { tools: [], signal: new AbortController().signal });
    });

    const appendFields = logs
      .filter((line) => line.startsWith("chat.append "))
      .map((line) => JSON.parse(line.replace("chat.append ", "")) as Record<string, unknown>);

    assertEquals(appendFields, [
      { role: "user", textLength: "user secret".length },
      { role: "assistant", textLength: "assistant secret".length },
    ]);
  });
});
