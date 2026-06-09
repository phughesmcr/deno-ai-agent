import type { ChatMessageData, Tool } from "@lmstudio/sdk";

import type {
  EgressPort,
  EventStore,
  LeasedWorkItem,
  ModelTurnRequest,
  SessionContextEngine,
  WorkQueue,
} from "../core/mod.ts";
import type { TurnRunnerResult } from "../core/turn-runner.ts";
import { TurnRunner } from "../core/turn-runner.ts";
import { isRecord, textFromMessage } from "../shared/mod.ts";
import {
  parseTelegramEgressTarget,
  sendTelegramEgressPayload,
  type TelegramEgressApi,
  type TelegramEgressTarget,
} from "./telegram-egress.ts";
import { telegramTargetForWork } from "./work-payload.ts";

/** Options for running prepared queued work through the durable core turn runner. */
export interface RunQueuedPreparedTurnOptions {
  /** Durable event store. */
  events: EventStore;
  /** Durable work queue. */
  queue: WorkQueue;
  /** Session context engine for durable model turns and finalization. */
  context: SessionContextEngine;
  /** Adapter egress renderer. */
  egress: EgressPort;
  /** Current base system prompt. */
  baseSystemPrompt: string;
  /** Leased work item to settle. */
  work: LeasedWorkItem;
  /** Prepared user message to persist as the turn input. */
  userMessage: ChatMessageData;
  /** Tools available during the turn. */
  tools: readonly Tool[];
  /** Optional tool-call guard. */
  guardToolCall?: ModelTurnRequest["guardToolCall"];
  /** Optional model-act observer. */
  observer?: ModelTurnRequest["observer"];
  /** Signal that cancels model execution. */
  signal: AbortSignal;
  /** How to settle work when model execution aborts. */
  abortDisposition?: "cancel" | "release" | ((work: LeasedWorkItem, error: unknown) => "cancel" | "release");
  /** Fallback text when the model completes without reply chunks. */
  fallbackText?: string;
}

interface TurnEgressPayload {
  target: TelegramEgressTarget;
  replies: string[];
  fallbackText?: string;
}

function imageCountFromMessage(message: ChatMessageData): number {
  return message.content.filter((part) => isRecord(part) && part["type"] === "file" && part["fileType"] === "image")
    .length;
}

function turnEgressPayload(value: unknown): TurnEgressPayload {
  if (!isRecord(value)) throw new Error("Invalid queued turn egress payload");
  const target = parseTelegramEgressTarget(value["target"]);
  const replies = value["replies"];
  const fallbackText = value["fallbackText"];
  if (!target || !Array.isArray(replies) || !replies.every((reply) => typeof reply === "string")) {
    throw new Error("Invalid queued turn egress payload");
  }
  if (fallbackText !== undefined && typeof fallbackText !== "string") {
    throw new Error("Invalid queued turn egress payload");
  }
  return {
    target,
    replies,
    ...(fallbackText !== undefined ? { fallbackText } : {}),
  };
}

/** Creates an egress adapter that renders TurnRunner egress payloads to Telegram. */
export function createTelegramTurnEgressPort(api: TelegramEgressApi): EgressPort {
  return {
    async send(payload: unknown): Promise<void> {
      await sendTelegramEgressPayload(api, turnEgressPayload(payload));
    },
  };
}

/** Runs one prepared queued turn through the durable core TurnRunner. */
export async function runQueuedPreparedTurn(
  options: RunQueuedPreparedTurnOptions,
): Promise<TurnRunnerResult> {
  const runner = new TurnRunner({
    events: options.events,
    queue: options.queue,
    context: options.context,
    egress: options.egress,
    tools: () => options.tools,
    baseSystemPrompt: () => options.baseSystemPrompt,
    guardToolCall: () => options.guardToolCall,
    observer: () => options.observer,
  });
  const target = telegramTargetForWork(options.work);
  if (!target) throw new Error("Queued turn work does not contain a Telegram egress target");
  const imageCount = imageCountFromMessage(options.userMessage);
  return await runner.run(options.work, {
    signal: options.signal,
    input: {
      message: options.userMessage,
      audit: {
        text: textFromMessage(options.userMessage),
        ...(imageCount > 0 ? { imageCount } : {}),
      },
    },
    egress: { target },
    abortDisposition: options.abortDisposition,
    ...(options.fallbackText !== undefined ? { fallbackText: options.fallbackText } : {}),
  });
}
