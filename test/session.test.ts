import { type Chat, ChatMessage, type ChatMessageData, type LLM, type LMStudioClient, type Tool } from "@lmstudio/sdk";
import { assert } from "jsr:@std/assert@1/assert";
import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertStringIncludes } from "jsr:@std/assert@1/string-includes";
import type { SummaryCompactor } from "../src/agent/context/compactor.ts";
import { SessionStore } from "../src/agent/context/session-store.ts";
import { type ModelActObserver, SessionManager } from "../src/agent/context/session.ts";
import { withEnv } from "./_env.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

interface FakeActOptions {
  guardToolCall?: unknown;
  contextOverflowPolicy?: "truncateMiddle" | "stopAtLimit" | "rollingWindow";
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
  options: FakeActOptions;
}

class FakeModel {
  replies = ["reply"];
  messages?: ChatMessage[];
  emitToolEvents = false;
  readonly actCalls: FakeActCall[] = [];
  readonly countTokenInputs: string[] = [];

  act(chat: Chat, tools: Tool[], options: FakeActOptions): Promise<void> {
    this.actCalls.push({ chat, tools, options });
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

function assistantToolRequestMessage(text: string): ChatMessage {
  return ChatMessage.from(
    {
      role: "assistant",
      content: [
        { type: "text", text },
        {
          type: "toolCallRequest",
          toolCallRequest: {
            id: "tool-call-1",
            type: "function",
            name: "read",
            arguments: { path: "README.md" },
          },
        },
      ],
    } satisfies ChatMessageData,
  );
}

function snapshot(chat: Chat): [string, string][] {
  return chat.getMessagesArray().map((message) => [message.getRole(), message.getText()]);
}

function fakeLmClient(): LMStudioClient {
  return {
    files: {
      createFileHandleFromChatMessagePartFileData(): never {
        throw new Error("file unavailable in test");
      },
    },
  } as unknown as LMStudioClient;
}

function messageHasImagePart(data: ChatMessageData): boolean {
  return data.content.some((part) => part.type === "file" && part.fileType === "image");
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
  fn: (spec: { session: SessionManager; store: SessionStore; model: FakeModel }) => Promise<void>,
  options?: {
    reserveTokens?: number;
    keepRecentTokens?: number;
    compactor?: SummaryCompactor;
    maxContextLength?: number;
    systemPrompt?: string;
    client?: LMStudioClient;
  },
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-session-" });
  try {
    const store = new SessionStore(dir);
    const model = new FakeModel();
    const session = new SessionManager({
      client: options?.client ?? fakeLmClient(),
      store,
      model: model as unknown as LLM,
      systemPrompt: options?.systemPrompt ?? "current system prompt",
      maxContextLength: options?.maxContextLength ?? 100,
      reserveTokens: options?.reserveTokens,
      keepRecentTokens: options?.keepRecentTokens,
      compactor: options?.compactor ?? (() => Promise.resolve("summary")),
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
    assertEquals(result.replyTexts, ["reply"]);
    assertEquals(result.turnTokens, 5);
    assertEquals(result.compacted, false);
    assertEquals(result.totalTokens, 9);
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

Deno.test("SessionManager forwards guardToolCall to model.act", async () => {
  await withSession(async ({ session, model }) => {
    const tools = [{ name: "fake-tool" }] as unknown as Tool[];
    const guardToolCall = () => {};

    await session.runTurn("hello", {
      tools,
      guardToolCall,
      signal: new AbortController().signal,
    });

    assertEquals(model.actCalls[0]?.options.guardToolCall, guardToolCall);
  });
});

Deno.test("SessionManager uses rolling overflow policy for tool-heavy turns", async () => {
  await withSession(async ({ session, model }) => {
    await session.runTurn("hello", { tools: [], signal: new AbortController().signal });

    assertEquals(model.actCalls[0]?.options.contextOverflowPolicy, "rollingWindow");
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

Deno.test("SessionManager does not return assistant tool request text as a Telegram reply", async () => {
  await withSession(async ({ session, model }) => {
    model.messages = [
      assistantToolRequestMessage("I will call a tool first."),
      toolMessage("tool result"),
      ChatMessage.create("assistant", "final answer"),
    ];

    const result = await session.runTurn("use a tool", {
      tools: [],
      signal: new AbortController().signal,
    });

    assertEquals(result.replyTexts, ["final answer"]);

    await session.runTurn("follow up", { tools: [], signal: new AbortController().signal });
    const call = model.actCalls[1];
    assert(call);
    assertEquals(snapshot(call.chat), [
      ["system", "current system prompt"],
      ["user", "use a tool"],
      ["assistant", "I will call a tool first."],
      ["tool", ""],
      ["assistant", "final answer"],
      ["user", "follow up"],
    ]);
    assertStringIncludes(call.chat.getMessagesArray()[2]?.toString() ?? "", 'read({"path":"README.md"})');
  });
});

Deno.test("SessionManager strips thinking from session but not replyTexts when KEEP_THINKING=false", async () => {
  await withEnv({ KEEP_THINKING: "false" }, async () => {
    await withSession(async ({ session, model }) => {
      const raw = "<think>secret</think>visible";
      model.replies = [raw];

      const result = await session.runTurn("hello", { tools: [], signal: new AbortController().signal });
      assertEquals(result.replyTexts, [raw]);

      await session.runTurn("follow-up", { tools: [], signal: new AbortController().signal });
      const call = model.actCalls[1];
      assert(call);
      assertEquals(snapshot(call.chat), [
        ["system", "current system prompt"],
        ["user", "hello"],
        ["assistant", "visible"],
        ["user", "follow-up"],
      ]);
    });
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

Deno.test("SessionManager rename before save writes name on first persist", async () => {
  await withSession(async ({ session, store }) => {
    await session.rename("my-alias");
    await session.runTurn("hello", { tools: [], signal: new AbortController().signal });
    const header = await store.readHeader(session.id);
    assertEquals(header.name, "my-alias");
    assertEquals(header.version, 3);
  });
});

Deno.test("SessionManager rename on saved session updates header", async () => {
  await withSession(async ({ session, store }) => {
    await session.runTurn("hello", { tools: [], signal: new AbortController().signal });
    await session.rename("saved-alias");
    const header = await store.readHeader(session.id);
    assertEquals(header.name, "saved-alias");
  });
});

Deno.test("SessionManager load resolves session by name", async () => {
  await withSession(async ({ session, store }) => {
    const id = crypto.randomUUID();
    await store.create(id, { name: "disk-alias" });
    await store.append(id, {
      type: "message",
      id: crypto.randomUUID(),
      createdAt: "2026-06-03T00:00:00.000Z",
      message: rawMessage("user", "from disk"),
    });

    await session.load("disk-alias");
    assertEquals(session.id, id);
    assertEquals(session.status().name, "disk-alias");
  });
});

Deno.test("SessionManager fork and newSession clear name", async () => {
  await withSession(async ({ session }) => {
    await session.rename("branch");
    await session.runTurn("x", { tools: [], signal: new AbortController().signal });
    assertEquals(session.status().name, "branch");

    const { toId } = await session.fork();
    assertEquals(session.status().name, undefined);
    assertEquals(session.id, toId);

    session.newSession();
    assertEquals(session.status().name, undefined);
  });
});

Deno.test("SessionManager load reapplies the current prompt over saved prompt", async () => {
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

Deno.test("SessionManager persists turns immediately", async () => {
  await withSession(async ({ session }) => {
    await session.runTurn("change", { tools: [], signal: new AbortController().signal });

    assertEquals(session.status().existsOnDisk, true);
    assertEquals(session.status().dirty, false);
  });
});

Deno.test("SessionManager manual compaction runs below the automatic token budget", async () => {
  const summarized: ChatMessageData[][] = [];
  await withSession(
    async ({ session, model }) => {
      model.replies = ["first reply"];
      await session.runTurn("first", { tools: [], signal: new AbortController().signal });
      model.replies = ["second reply"];
      await session.runTurn("second", { tools: [], signal: new AbortController().signal });

      const result = await session.compact("manual checkpoint");

      assertEquals(result.compacted, true);
      assertEquals(result.beforeTokens, 16);
      assertEquals(result.afterTokens, 4);
      assertEquals(summarized[0]?.map((message) => message.role), ["user", "assistant", "user", "assistant"]);

      model.replies = ["after manual"];
      await session.runTurn("after compact", { tools: [], signal: new AbortController().signal });
      const call = model.actCalls[2];
      assert(call);
      assertEquals(snapshot(call.chat), [
        ["system", "current system prompt"],
        ["user", "[Earlier conversation summary]\nmanual summary"],
        ["user", "after compact"],
      ]);
    },
    {
      compactor: (input) => {
        summarized.push(input.messages);
        assertEquals(input.instructions, "manual checkpoint");
        return Promise.resolve("manual summary");
      },
    },
  );
});

Deno.test("SessionManager appends compaction checkpoints and preserves the current prompt", async () => {
  await withSession(
    async ({ session, model }) => {
      const first = await session.runTurn("too much context", { tools: [], signal: new AbortController().signal });
      assertEquals(first.compacted, true);
      assertEquals(first.totalTokens, 9);

      await session.runTurn("after compact", { tools: [], signal: new AbortController().signal });

      const call = model.actCalls[1];
      assert(call);
      assertEquals(snapshot(call.chat), [
        ["system", "current system prompt"],
        ["user", "[Earlier conversation summary]\nsummary"],
        ["assistant", "reply"],
        ["user", "after compact"],
      ]);
    },
    {
      maxContextLength: 10,
      reserveTokens: 2,
      keepRecentTokens: 5,
      compactor: () => Promise.resolve("summary"),
    },
  );
});

Deno.test("SessionManager derives compaction budgets from context length by default", async () => {
  const summarized: ChatMessageData[][] = [];
  await withSession(
    async ({ session }) => {
      const first = await session.runTurn("one", { tools: [], signal: new AbortController().signal });
      const second = await session.runTurn("two", { tools: [], signal: new AbortController().signal });
      const third = await session.runTurn("three", { tools: [], signal: new AbortController().signal });

      assertEquals(first.compacted, false);
      assertEquals(second.compacted, false);
      assertEquals(third.compacted, true);
      assertEquals(third.totalTokens, 16);
      assertEquals(summarized[0]?.map((message) => message.role), ["user", "assistant", "user"]);
    },
    {
      maxContextLength: 24,
      compactor: (input) => {
        summarized.push(input.messages);
        return Promise.resolve("summary");
      },
    },
  );
});

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

Deno.test({
  name: "SessionManager persists image file parts on runTurn",
  ignore: !Deno.env.get("LMSTUDIO_IMAGE_TEST"),
}, async () => {
  const { LMStudioClient } = await import("@lmstudio/sdk");
  const client = new LMStudioClient();
  const handle = await client.files.prepareImageBase64("session-test.png", TINY_PNG_BASE64);

  await withSession(async ({ session, model }) => {
    await session.runTurn({ text: "describe", images: [handle] }, {
      tools: [],
      signal: new AbortController().signal,
    });

    const call = model.actCalls[0];
    assert(call);
    const userMessage = call.chat.getMessagesArray().find((m) => m.getRole() === "user");
    assert(userMessage);
    const raw = (userMessage as ChatMessageWithRaw).getRaw();
    assert(messageHasImagePart(raw));
  }, { client });
});

Deno.test({
  name: "SessionManager keeps image parts in context on a follow-up turn",
  ignore: !Deno.env.get("LMSTUDIO_IMAGE_TEST"),
}, async () => {
  const { LMStudioClient } = await import("@lmstudio/sdk");
  const client = new LMStudioClient();
  const handle = await client.files.prepareImageBase64("follow-up.png", TINY_PNG_BASE64);

  await withSession(async ({ session, model }) => {
    await session.runTurn({ text: "look", images: [handle] }, {
      tools: [],
      signal: new AbortController().signal,
    });
    await session.runTurn("follow up", { tools: [], signal: new AbortController().signal });

    const call = model.actCalls[1];
    assert(call);
    const userMessages = call.chat.getMessagesArray().filter((m) => m.getRole() === "user");
    const withImage = userMessages.some((m) => messageHasImagePart((m as ChatMessageWithRaw).getRaw()));
    assert(withImage);
  }, { client });
});
