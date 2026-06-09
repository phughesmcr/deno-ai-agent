import { ChatMessage, type ChatMessageData, type Tool } from "@lmstudio/sdk";

import {
  type ContextSummaryPort,
  type EgressPort,
  type KvKernelStore,
  type ModelTurnOutput,
  type ModelTurnPort,
  type ModelTurnRequest,
  SessionContextEngine,
  type SummaryCompactionInput,
} from "../../src/core/mod.ts";
import type { RunTurnWorkOptions } from "../../src/core/turn-runner.ts";

export type { ChatMessageData, Tool };

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

export class FakeModelTurnPort implements ModelTurnPort {
  readonly requests: ModelTurnRequest[] = [];
  output: ModelTurnOutput = {
    persistedMessages: [rawMessage("assistant", "done")],
    replyTexts: ["done"],
  };
  emitToolEvents = false;
  roundIndexes: number[] = [];
  failAfterToolEvents: Error | undefined;
  error: Error | undefined;

  run(request: ModelTurnRequest): Promise<ModelTurnOutput> {
    this.requests.push(request);
    for (const roundIndex of this.roundIndexes) {
      request.observer?.onRoundStart(roundIndex);
      request.observer?.onRoundEnd(roundIndex);
    }
    if (this.emitToolEvents) {
      request.observer?.onToolCallRequestStart(0, 7, "tool-call-7");
      request.observer?.onToolCallRequestNameReceived(7, "read");
      request.observer?.onToolCallRequestEnd(0, 7, "read", false);
      request.observer?.onToolCallRequestDequeued(0, 7);
      request.observer?.onToolCallRequestFinalized(7, "read");
    }
    if (this.failAfterToolEvents) return Promise.reject(this.failAfterToolEvents);
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve(this.output);
  }

  countTokens(messages: ChatMessageData[]): Promise<number[]> {
    return Promise.resolve(messages.map(() => 1));
  }
}

export class RecordingEgressPort implements EgressPort {
  readonly payloads: unknown[] = [];

  send(payload: unknown): Promise<void> {
    this.payloads.push(payload);
    return Promise.resolve();
  }
}

export class RecordingSummaryPort implements ContextSummaryPort {
  readonly inputs: SummaryCompactionInput[] = [];
  summary = "compact summary";

  summarize(input: SummaryCompactionInput): Promise<string> {
    this.inputs.push(input);
    return Promise.resolve(this.summary);
  }
}

export class FailingSummaryPort implements ContextSummaryPort {
  summarize(): Promise<never> {
    return Promise.reject(new Error("finalizer failed"));
  }
}

export function recordingObserver(events: string[]): NonNullable<ModelTurnRequest["observer"]> {
  return {
    onMessage(): void {
      events.push("message");
    },
    onFirstToken(roundIndex: number, ms?: number): void {
      events.push(`first:${roundIndex}:${ms ?? ""}`);
    },
    onRoundStart(roundIndex: number): void {
      events.push(`round-start:${roundIndex}`);
    },
    onRoundEnd(roundIndex: number): void {
      events.push(`round-end:${roundIndex}`);
    },
    onToolCallRequestStart(roundIndex: number, callId: number, toolCallId?: string): void {
      events.push(`tool-start:${roundIndex}:${callId}:${toolCallId ?? ""}`);
    },
    onToolCallRequestNameReceived(callId: number, name: string): void {
      events.push(`tool-name:${callId}:${name}`);
    },
    onToolCallRequestEnd(roundIndex: number, callId: number, name: string, isQueued: boolean): void {
      events.push(`tool-end:${roundIndex}:${callId}:${name}:${isQueued}`);
    },
    onToolCallRequestFailure(callId: number, message: string): void {
      events.push(`tool-fail:${callId}:${message}`);
    },
    onToolCallRequestFinalized(callId: number, name: string): void {
      events.push(`tool-final:${callId}:${name}`);
    },
    onToolCallRequestDequeued(roundIndex: number, callId: number): void {
      events.push(`tool-dequeue:${roundIndex}:${callId}`);
    },
  };
}

export function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

export function textOf(message: { content: readonly unknown[] }): string {
  return message.content.flatMap((part) => {
    if (part === null || typeof part !== "object") return [];
    if (!("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") {
      return [];
    }
    return [part.text];
  }).join("");
}

export function turnRunOptions(options: {
  signal?: AbortSignal;
  message?: ChatMessageData;
  target?: unknown;
  fallbackText?: string;
  abortDisposition?: RunTurnWorkOptions["abortDisposition"];
} = {}): RunTurnWorkOptions {
  const message = options.message ?? rawMessage("user", "hello");
  return {
    signal: options.signal ?? new AbortController().signal,
    input: {
      message,
      audit: {
        text: textOf(message),
        ...(imageCount(message) > 0 ? { imageCount: imageCount(message) } : {}),
      },
    },
    egress: { target: options.target ?? { kind: "telegram", chatId: 123 } },
    ...(options.fallbackText !== undefined ? { fallbackText: options.fallbackText } : {}),
    ...(options.abortDisposition !== undefined ? { abortDisposition: options.abortDisposition } : {}),
  };
}

export async function withKv(fn: (kv: Deno.Kv) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

export function contextEngine(
  events: KvKernelStore,
  model: ModelTurnPort,
  options?: { summary?: ContextSummaryPort; maxContextLength?: number; reserveTokens?: number },
): SessionContextEngine {
  return new SessionContextEngine({
    events,
    model,
    summary: options?.summary ?? new RecordingSummaryPort(),
    maxContextLength: options?.maxContextLength ?? 100,
    ...(options?.reserveTokens !== undefined ? { reserveTokens: options.reserveTokens } : {}),
  });
}

function imageCount(message: ChatMessageData): number {
  return message.content.filter((part) => {
    if (part === null || typeof part !== "object") return false;
    return "type" in part && part.type === "file" && "fileType" in part && part.fileType === "image";
  }).length;
}
