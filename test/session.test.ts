import { Chat, ChatMessage, type ChatMessageData, type LLM, type Tool } from "@lmstudio/sdk";
import { assert } from "jsr:@std/assert@1/assert";
import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertStringIncludes } from "jsr:@std/assert@1/string-includes";
import { SessionStore } from "../src/agent/context/session-store.ts";
import { type ModelActObserver, SessionManager } from "../src/agent/context/session.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

interface FakeActOptions {
  onMessage?: (message: ChatMessage) => void;
  onFirstToken?: (roundIndex: number) => void;
  onRoundStart?: (roundIndex: number) => void;
  onRoundEnd?: (roundIndex: number) => void;
  onToolCallRequestStart?: (roundIndex: number, callId: number, info: { toolCallId?: string }) => void;
  onToolCallRequestNameReceived?: (roundIndex: number, callId: number, name: string) => void;
  onToolCallRequestEnd?: (
    roundIndex: number,
    callId: number,
    info: { toolCallRequest: { name: string }; isQueued: boolean },
  ) => void;
  onToolCallRequestFailure?: (roundIndex: number, callId: number, error: Error) => void;
  onToolCallRequestFinalized?: (
    roundIndex: number,
    callId: number,
    info: { toolCallRequest: { name: string } },
  ) => void;
  onToolCallRequestDequeued?: (roundIndex: number, callId: number) => void;
}

interface FakeActCall {
  chat: Chat;
  tools: Tool[];
}

class FakeModel {
  replies = ["reply"];
  messages?: ChatMessage[];
  emitToolEvents = false;
  readonly actCalls: FakeActCall[] = [];
  readonly countTokenInputs: string[] = [];

  act(chat: Chat, tools: Tool[], options: FakeActOptions): Promise<void> {
    this.actCalls.push({ chat, tools });
    options.onRoundStart?.(0);
    options.onFirstToken?.(0);

    if (this.emitToolEvents) {
      options.onToolCallRequestStart?.(0, 7, { toolCallId: "tool-1" });
      options.onToolCallRequestNameReceived?.(0, 7, "read");
      options.onToolCallRequestEnd?.(0, 7, { toolCallRequest: { name: "read" }, isQueued: true });
      options.onToolCallRequestDequeued?.(0, 7);
      options.onToolCallRequestFailure?.(0, 8, new Error("tool failed"));
      options.onToolCallRequestFinalized?.(0, 7, { toolCallRequest: { name: "read" } });
    }

    const messages = this.messages ?? this.replies.map((reply) => ChatMessage.create("assistant", reply));
    for (const message of messages) {
      options.onMessage?.(message);
    }
    options.onRoundEnd?.(0);
    return Promise.resolve();
  }

  countTokens(text: string): Promise<number> {
    this.countTokenInputs.push(text);
    if (text.startsWith("assistant:")) return Promise.resolve(5);
    return Promise.resolve(2);
  }
}

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

function toolMessage(text: string): ChatMessage {
  return ChatMessage.from(
    {
      role: "tool",
      content: [{ type: "toolCallResult", content: text, toolCallId: "tool-call-1" }],
    } satisfies ChatMessageData,
  );
}

function snapshot(chat: Chat): [string, string][] {
  return chat.getMessagesArray().map((message) => [message.getRole(), message.getText()]);
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
  // deno-lint-ignore no-console
  const originalError = console.error;
  // deno-lint-ignore no-console
  console.error = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  Deno.env.set("LOG_LEVEL", "debug");

  return fn().then(
    () => lines,
    (error) => {
      throw error;
    },
  ).finally(() => {
    // deno-lint-ignore no-console
    console.error = originalError;
    if (previousLevel === undefined) {
      Deno.env.delete("LOG_LEVEL");
    } else {
      Deno.env.set("LOG_LEVEL", previousLevel);
    }
  });
}

async function withSession(
  fn: (spec: { session: SessionManager; store: SessionStore; model: FakeModel }) => Promise<void>,
  options?: {
    compactPercentage?: number;
    compactor?: (chat: Chat) => Promise<Chat>;
    maxContextLength?: number;
    systemPrompt?: string;
  },
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-session-" });
  try {
    const store = new SessionStore(dir);
    const model = new FakeModel();
    const session = new SessionManager({
      store,
      model: model as unknown as LLM,
      systemPrompt: options?.systemPrompt ?? "current system prompt",
      maxContextLength: options?.maxContextLength ?? 100,
      compactPercentage: options?.compactPercentage,
      compactor: options?.compactor ?? ((chat) => Promise.resolve(chat)),
    });
    await fn({ session, store, model });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("SessionManager sends prompt, user text, tools, replies, tokens, and observer events through runTurn", async () => {
  await withSession(async ({ session, model }) => {
    model.emitToolEvents = true;
    const events: string[] = [];
    const tools = [{ name: "fake-tool" }] as unknown as Tool[];

    const result = await session.runTurn("hello", {
      tools,
      signal: new AbortController().signal,
      observer: recordingObserver(events),
    });

    const call = model.actCalls[0];
    assert(call);
    assertEquals(call.tools, tools);
    assertEquals(snapshot(call.chat), [
      ["system", "current system prompt"],
      ["user", "hello"],
    ]);
    assertEquals(result, {
      replyTexts: ["reply"],
      turnTokens: 5,
      compacted: false,
      totalTokens: 9,
    });
    assertEquals(events, [
      "round-start:0",
      "first:0:number",
      "tool-start:0:7:tool-1",
      "tool-name:7:read",
      "tool-end:0:7:read:true",
      "tool-dequeued:0:7",
      "tool-failure:8:tool failed",
      "tool-finalized:7:read",
      "message",
      "round-end:0",
    ]);
  });
});

Deno.test("SessionManager keeps tool results in context without returning them as Telegram replies", async () => {
  await withSession(async ({ session, model }) => {
    model.messages = [
      toolMessage('<skill_content name="docs">\nSkill body\n</skill_content>'),
      ChatMessage.create("assistant", "visible reply"),
    ];

    const result = await session.runTurn("load docs skill", {
      tools: [],
      signal: new AbortController().signal,
    });

    assertEquals(result.replyTexts, ["visible reply"]);
    assertEquals(result.turnTokens, 7);
    assertEquals(result.totalTokens, 11);

    await session.runTurn("after tool", { tools: [], signal: new AbortController().signal });
    const call = model.actCalls[1];
    assert(call);
    assertEquals(snapshot(call.chat), [
      ["system", "current system prompt"],
      ["user", "load docs skill"],
      ["tool", ""],
      ["assistant", "visible reply"],
      ["user", "after tool"],
    ]);
    assertStringIncludes(call.chat.getMessagesArray()[2]?.toString() ?? "", '<skill_content name="docs">');
  });
});

Deno.test("SessionManager newSession keeps the current system prompt", async () => {
  await withSession(async ({ session, model }) => {
    session.newSession();
    await session.runTurn("fresh", { tools: [], signal: new AbortController().signal });

    const call = model.actCalls[0];
    assert(call);
    assertEquals(snapshot(call.chat), [
      ["system", "current system prompt"],
      ["user", "fresh"],
    ]);
  });
});

Deno.test("SessionManager load reapplies the current prompt over saved prompt", async () => {
  await withSession(async ({ session, store, model }) => {
    const id = crypto.randomUUID();
    await store.save(id, [
      rawMessage("system", "old prompt"),
      rawMessage("user", "from disk"),
    ]);

    await session.load(id);
    await session.runTurn("after load", { tools: [], signal: new AbortController().signal });

    const call = model.actCalls[0];
    assert(call);
    assertEquals(snapshot(call.chat), [
      ["system", "current system prompt"],
      ["user", "from disk"],
      ["user", "after load"],
    ]);
  });
});

Deno.test("SessionManager debug append logs metadata without message text", async () => {
  await withSession(async ({ session, model }) => {
    model.replies = ["assistant secret"];

    const logs = await withDebugLogs(async () => {
      await session.runTurn("user secret", { tools: [], signal: new AbortController().signal });
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

Deno.test("SessionManager fork preserves messages and reapplies the prompt", async () => {
  await withSession(async ({ session, model }) => {
    model.replies = ["before reply"];
    await session.runTurn("before fork", { tools: [], signal: new AbortController().signal });

    const { fromId, toId } = await session.fork();
    assert(fromId !== toId);

    model.replies = ["after reply"];
    await session.runTurn("after fork", { tools: [], signal: new AbortController().signal });

    const call = model.actCalls[1];
    assert(call);
    assertEquals(snapshot(call.chat), [
      ["system", "current system prompt"],
      ["user", "before fork"],
      ["assistant", "before reply"],
      ["user", "after fork"],
    ]);
  });
});

Deno.test("SessionManager keeps existsOnDisk true when a saved session becomes dirty", async () => {
  await withSession(async ({ session }) => {
    await session.save();
    assertEquals(session.status().existsOnDisk, true);
    assertEquals(session.status().dirty, false);

    await session.runTurn("change", { tools: [], signal: new AbortController().signal });

    assertEquals(session.status().existsOnDisk, true);
    assertEquals(session.status().dirty, true);
  });
});

Deno.test("SessionManager compacts over-budget turns and preserves the current prompt", async () => {
  const compacted = Chat.empty();
  compacted.replaceSystemPrompt("stale prompt from compactor");
  compacted.append("user", "summary");

  await withSession(
    async ({ session, model }) => {
      const first = await session.runTurn("too much context", { tools: [], signal: new AbortController().signal });
      assertEquals(first.compacted, true);
      assertEquals(first.totalTokens, 4);

      await session.runTurn("after compact", { tools: [], signal: new AbortController().signal });

      const call = model.actCalls[1];
      assert(call);
      assertEquals(snapshot(call.chat), [
        ["system", "current system prompt"],
        ["user", "summary"],
        ["user", "after compact"],
      ]);
    },
    {
      maxContextLength: 5,
      compactPercentage: 0.1,
      compactor: () => Promise.resolve(compacted),
    },
  );
});
