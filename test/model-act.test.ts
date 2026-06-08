import { type Chat, ChatMessage, type ChatMessageData, type LLM, type LMStudioClient, type Tool } from "@lmstudio/sdk";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";

import type { ModelActObserver } from "../src/core/mod.ts";
import { LmStudioAgentModelAct } from "../src/agent/model-act.ts";
import { withEnv } from "./_env.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

interface FakeActOptions {
  guardToolCall?: unknown;
  contextOverflowPolicy?: "truncateMiddle" | "stopAtLimit" | "rollingWindow";
  allowParallelToolExecution?: boolean;
  maxTokens?: number;
  maxPredictionRounds?: number;
  structured?: { type: "json"; jsonSchema?: unknown };
  signal?: AbortSignal;
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

class FakeSdkModel {
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
    for (const message of messages) options.onMessage?.(message);
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

function toolResultMessage(text: string): ChatMessageData {
  return {
    role: "tool",
    content: [{ type: "toolCallResult", content: text, toolCallId: "tool-call-1" }],
  } as ChatMessageData;
}

function skillToolMessage(name: string, body: string): ChatMessageData {
  return toolResultMessage(`<skill_content name="${name}">\n${body}\n</skill_content>`);
}

function assistantToolRequestMessage(text: string): ChatMessageData {
  return {
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
  } as ChatMessageData;
}

function imageMessage(text: string): ChatMessageData {
  return {
    role: "user",
    content: [
      { type: "text", text },
      {
        type: "file",
        name: "photo.jpg",
        identifier: "id-1",
        sizeBytes: 100,
        fileType: "image",
      },
    ],
  } as unknown as ChatMessageData;
}

function textOf(message: ChatMessageData): string {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

function rolesAndText(messages: ChatMessageData[]): [string, string][] {
  return messages.map((message) => [message.role, textOf(message)]);
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

Deno.test("LmStudioAgentModelAct normal turn assembles chat, forwards options, and extracts visible replies", async () => {
  const sdkModel = new FakeSdkModel();
  sdkModel.emitToolEvents = true;
  sdkModel.messages = [
    ChatMessage.from(assistantToolRequestMessage("I will call a tool first.")),
    ChatMessage.from(toolResultMessage("tool result")),
    ChatMessage.create("assistant", "final answer"),
  ];
  const port = new LmStudioAgentModelAct({ client: fakeLmClient(), model: sdkModel as unknown as LLM });
  const events: string[] = [];
  const tools = [{ name: "fake-tool" }] as unknown as Tool[];
  const signal = new AbortController().signal;
  const guardToolCall = () => {};

  const output = await port.run({
    systemPrompt: "current system prompt",
    messages: [rawMessage("user", "use a tool")],
    tools,
    guardToolCall,
    signal,
    observer: recordingObserver(events),
  });

  const call = sdkModel.actCalls[0];
  assert(call);
  assertEquals(call.tools, tools);
  assertEquals(call.options.guardToolCall, guardToolCall);
  assertEquals(call.options.signal, signal);
  assertEquals(call.options.contextOverflowPolicy, "rollingWindow");
  assertEquals(call.options.allowParallelToolExecution, true);
  assertEquals(call.options.maxTokens, 4096);
  assertEquals(snapshot(call.chat), [
    ["system", "current system prompt"],
    ["user", "use a tool"],
  ]);
  assertEquals(output.replyTexts, ["final answer"]);
  assertEquals(output.persistedMessages.map((message) => message.role), ["assistant", "tool", "assistant"]);
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
    "message",
    "message",
    "round-end:0",
  ]);
});

Deno.test("LmStudioAgentModelAct normal turn strips thinking from persistence but not raw replies", async () => {
  await withEnv({ KEEP_THINKING: "false" }, async () => {
    const sdkModel = new FakeSdkModel();
    const raw = "<think>secret</think>visible";
    sdkModel.replies = [raw];
    const port = new LmStudioAgentModelAct({ client: fakeLmClient(), model: sdkModel as unknown as LLM });

    const output = await port.run({
      systemPrompt: "current system prompt",
      messages: [rawMessage("user", "hello")],
      tools: [],
      signal: new AbortController().signal,
    });

    assertEquals(output.replyTexts, [raw]);
    assertEquals(rolesAndText(output.persistedMessages), [["assistant", "visible"]]);
  });
});

Deno.test("LmStudioAgentModelAct summarize uses truncateMiddle, no tools, and practical finalization", async () => {
  await withEnv({ KEEP_THINKING: "false" }, async () => {
    const sdkModel = new FakeSdkModel();
    sdkModel.replies = ["<think>summary thoughts</think>Goal\n- keep going"];
    const signal = new AbortController().signal;
    const port = new LmStudioAgentModelAct({
      client: fakeLmClient(),
      model: sdkModel as unknown as LLM,
      signal,
      summaryToolResultLimit: 12,
    });

    const summary = await port.summarize({
      systemPrompt: "system prompt",
      previousSummary: "previous checkpoint",
      messages: [
        rawMessage("user", "first"),
        toolResultMessage("abcdefghijklmnopqrstuvwxyz"),
        skillToolMessage("docs", "new docs instructions"),
        imageMessage("see this"),
      ],
      instructions: "focus on files",
      details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] },
    });

    const call = sdkModel.actCalls[0];
    assert(call);
    assertEquals(call.tools, []);
    assertEquals(call.options.signal, signal);
    assertEquals(call.options.contextOverflowPolicy, "truncateMiddle");
    assertEquals(call.options.allowParallelToolExecution, true);
    assertEquals(snapshot(call.chat).at(0), ["system", "system prompt"]);
    const prompt = snapshot(call.chat).at(-1)?.[1] ?? "";
    assertStringIncludes(prompt, "Previous checkpoint summary:");
    assertStringIncludes(prompt, "Additional user compaction instructions:");
    assertStringIncludes(prompt, "abcdefghijkl");
    assertStringIncludes(prompt, "[tool result truncated at 12 chars]");
    assertStringIncludes(prompt, "attachments: 1 image(s): photo.jpg");
    assertStringIncludes(summary, "Goal\n- keep going");
    assertStringIncludes(summary, '<skill_content name="docs">');
    assertStringIncludes(summary, "<read-files>\nsrc/a.ts\n</read-files>");
    assertStringIncludes(summary, "<modified-files>\nsrc/b.ts\n</modified-files>");
    assertEquals(summary.includes("<think>"), false);
  });
});

Deno.test("LmStudioAgentModelAct extractCronSchedule returns validated JSON intent", async () => {
  const sdkModel = new FakeSdkModel();
  sdkModel.replies = [
    JSON.stringify({
      status: "ok",
      prompt: "ls the cwd",
      scheduleText: "every minute",
      schedule: {
        kind: "recurring",
        recurrence: { kind: "interval", every: 1, unit: "minute" },
      },
    }),
  ];
  const signal = new AbortController().signal;
  const port = new LmStudioAgentModelAct({ client: fakeLmClient(), model: sdkModel as unknown as LLM });

  const result = await port.extractCronSchedule({
    input: "every minute, ls the cwd",
    now: new Date("2026-06-05T16:19:47.000Z"),
    defaultTimezone: "Europe/London",
    signal,
  });

  const call = sdkModel.actCalls[0];
  assert(call);
  assertEquals(call.tools, []);
  assertEquals(call.options.signal, signal);
  assertEquals(call.options.maxTokens, 1024);
  assertEquals(call.options.maxPredictionRounds, 1);
  assertEquals(call.options.structured?.type, "json");
  assertEquals(snapshot(call.chat).at(0), [
    "system",
    "You extract cron scheduling intent and return strict JSON only.",
  ]);
  assertStringIncludes(snapshot(call.chat).at(-1)?.[1] ?? "", "Command: every minute, ls the cwd");
  assertEquals(result, {
    status: "ok",
    prompt: "ls the cwd",
    scheduleText: "every minute",
    schedule: {
      kind: "recurring",
      recurrence: { kind: "interval", every: 1, unit: "minute" },
    },
  });
});

Deno.test("LmStudioAgentModelAct extractCronSchedule ignores thinking before JSON", async () => {
  const sdkModel = new FakeSdkModel();
  sdkModel.replies = [
    [
      "The user wants a recurring command. I should return JSON.",
      "```json",
      JSON.stringify({
        status: "ok",
        prompt: "ls the cwd",
        scheduleText: "every minute",
        schedule: {
          kind: "recurring",
          recurrence: { kind: "interval", every: 1, unit: "minute" },
        },
      }),
      "```",
    ].join("\n"),
  ];
  const port = new LmStudioAgentModelAct({ client: fakeLmClient(), model: sdkModel as unknown as LLM });

  const result = await port.extractCronSchedule({
    input: "every minute, ls the cwd",
    now: new Date("2026-06-05T16:19:47.000Z"),
    defaultTimezone: "Europe/London",
  });

  assertEquals(result, {
    status: "ok",
    prompt: "ls the cwd",
    scheduleText: "every minute",
    schedule: {
      kind: "recurring",
      recurrence: { kind: "interval", every: 1, unit: "minute" },
    },
  });
});

Deno.test("LmStudioAgentModelAct extractCronSchedule rejects malformed schedule JSON", async () => {
  const sdkModel = new FakeSdkModel();
  sdkModel.replies = [JSON.stringify({ status: "ok", prompt: "", scheduleText: "", schedule: {} })];
  const port = new LmStudioAgentModelAct({ client: fakeLmClient(), model: sdkModel as unknown as LLM });

  await assertRejects(
    () =>
      port.extractCronSchedule({
        input: "every minute, ls the cwd",
        now: new Date("2026-06-05T16:19:47.000Z"),
        defaultTimezone: "Europe/London",
      }),
    Error,
  );
});

Deno.test("LmStudioAgentModelAct runSubagent uses truncateMiddle tools and returns stripped final assistant text", async () => {
  await withEnv({ KEEP_THINKING: "false" }, async () => {
    const sdkModel = new FakeSdkModel();
    sdkModel.messages = [
      ChatMessage.create("assistant", "<think>draft</think>draft result"),
      ChatMessage.create("assistant", "<think>final</think>final result"),
    ];
    const port = new LmStudioAgentModelAct({ client: fakeLmClient(), model: sdkModel as unknown as LLM });
    const tools = [{ name: "read" }, { name: "grep" }] as unknown as Tool[];
    const signal = new AbortController().signal;
    sdkModel.emitToolEvents = true;
    const events: string[] = [];

    const result = await port.runSubagent({
      systemPrompt: "subagent system",
      task: "Inspect the repo",
      tools,
      signal,
      observer: recordingObserver(events),
    });

    const call = sdkModel.actCalls[0];
    assert(call);
    assertEquals(call.tools, tools);
    assertEquals(call.options.signal, signal);
    assertEquals(call.options.contextOverflowPolicy, "truncateMiddle");
    assertEquals(call.options.allowParallelToolExecution, true);
    assertEquals(snapshot(call.chat), [
      ["system", "subagent system"],
      ["user", "Inspect the repo"],
    ]);
    assertEquals(result.text, "final result");
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
      "message",
      "round-end:0",
    ]);
  });
});

Deno.test("LmStudioAgentModelAct counts tokens through materialized chat messages", async () => {
  const sdkModel = new FakeSdkModel();
  const port = new LmStudioAgentModelAct({ client: fakeLmClient(), model: sdkModel as unknown as LLM });

  const counts = await port.countTokens([rawMessage("system", "prompt"), rawMessage("assistant", "reply")]);

  assertEquals(counts, [2, 5]);
  assertEquals(sdkModel.countTokenInputs, ["system: prompt", "assistant: reply"]);
});
