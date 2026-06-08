import type { ChatMessageData, Tool } from "@lmstudio/sdk";

import {
  type EgressPort,
  type EventStore,
  type LeasedWorkItem,
  type ModelTurnRequest,
  type SessionContextEngine,
  TurnRunner,
  type TurnRunnerResult,
  type WorkQueue,
} from "../core/mod.ts";
import {
  parseTelegramEgressTarget,
  sendTelegramEgressPayload,
  type TelegramEgressApi,
  type TelegramEgressTarget,
} from "./telegram-egress.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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
    fallbackText: () => options.fallbackText,
  });
  const preparedWork: LeasedWorkItem = {
    ...options.work,
    payload: {
      ...(isRecord(options.work.payload) ? options.work.payload : {}),
      input: { message: options.userMessage },
    },
  };
  return await runner.run(preparedWork, {
    signal: options.signal,
    abortDisposition: options.abortDisposition,
  });
}
