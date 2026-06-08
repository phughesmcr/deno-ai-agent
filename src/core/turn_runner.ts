import type { ChatMessageData, Tool } from "@lmstudio/sdk";

import { errorMessage } from "../shared/error.ts";
import { EgressOutbox } from "./egress_outbox.ts";
import type { EventStore } from "./events.ts";
import type { ModelTurnOutput, ModelTurnRequest } from "./model_turn.ts";
import type { FinalizeSessionTurnResult, SessionContextEngine } from "./session_context.ts";
import type { LeasedWorkItem, WorkQueue } from "./work_queue.ts";

/** Egress side-effect port for adapter rendering. */
export interface EgressPort {
  /** Sends a queued egress payload. */
  send(payload: unknown): Promise<void>;
}

/** Turn runner construction options. */
export interface TurnRunnerOptions {
  /** Durable event store. */
  events: EventStore;
  /** Durable work queue. */
  queue: WorkQueue;
  /** Session context engine for durable model turns and finalization. */
  context: SessionContextEngine;
  /** Adapter egress port. */
  egress: EgressPort;
  /** Tools available for a work item. */
  tools: (work: LeasedWorkItem) => readonly unknown[] | Promise<readonly unknown[]>;
  /** Current system prompt. */
  baseSystemPrompt: (work: LeasedWorkItem) => string | Promise<string>;
  /** Optional model tool-call guard. */
  guardToolCall?: (
    work: LeasedWorkItem,
  ) => ModelTurnRequest["guardToolCall"] | Promise<ModelTurnRequest["guardToolCall"]>;
  /** Optional telemetry/model-act observer for a work item. */
  observer?: (work: LeasedWorkItem) => ModelTurnRequest["observer"] | Promise<ModelTurnRequest["observer"]>;
  /** Optional fallback text to send when a completed model turn produced no reply chunks. */
  fallbackText?: (work: LeasedWorkItem) => string | undefined | Promise<string | undefined>;
}

/** Options for running one leased turn. */
export interface RunTurnWorkOptions {
  /** Abort signal for the active turn. */
  signal: AbortSignal;
  /** How to settle work when model execution aborts. Defaults to cancellation. */
  abortDisposition?: "cancel" | "release" | ((work: LeasedWorkItem, error: unknown) => "cancel" | "release");
}

/** Result of running one leased work item through the durable turn boundary. */
export interface TurnRunnerResult extends ModelTurnOutput {
  /** Token accounting and compaction result, when finalization succeeds. */
  finalization?: FinalizeSessionTurnResult;
  /** Non-terminal finalizer failure, when model output and egress still completed. */
  finalizationError?: string;
}

interface UserTurnPayload {
  input: {
    text: string;
    imageCount?: number;
  };
  message?: ChatMessageData;
  egress?: unknown;
}

interface EgressPayload {
  workId: string;
  sessionId: string;
  target: unknown;
  replies: string[];
  fallbackText?: string;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

function objectPayload(payload: unknown): Record<string, unknown> | null {
  if (payload === null || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

function isChatMessageData(value: unknown): value is ChatMessageData {
  const record = objectPayload(value);
  return typeof record?.["role"] === "string" && Array.isArray(record["content"]);
}

function textFromMessage(message: ChatMessageData): string {
  return message.content.flatMap((part) => {
    const record = objectPayload(part);
    if (record?.["type"] !== "text") return [];
    const text = record["text"];
    return typeof text === "string" ? [text] : [];
  }).join("");
}

function imageCountFromMessage(message: ChatMessageData): number {
  return message.content.filter((part) => {
    const record = objectPayload(part);
    return record?.["type"] === "file" && record["fileType"] === "image";
  }).length;
}

function inputFromMessage(message: ChatMessageData): UserTurnPayload["input"] {
  const imageCount = imageCountFromMessage(message);
  return {
    text: textFromMessage(message),
    ...(imageCount > 0 ? { imageCount } : {}),
  };
}

function preparedMessage(payload: unknown): ChatMessageData | null {
  const record = objectPayload(payload);
  const input = objectPayload(record?.["input"]);
  const message = input?.["message"];
  return isChatMessageData(message) ? message : null;
}

function workText(payload: unknown): string {
  const record = objectPayload(payload);
  const input = objectPayload(record?.["input"]);
  const inputText = input?.["text"];
  if (typeof inputText === "string") return inputText;
  const prompt = record?.["prompt"];
  if (typeof prompt === "string") return prompt;
  const text = record?.["text"];
  if (typeof text === "string") return text;
  throw new Error("Work payload does not contain text input");
}

function egressTarget(payload: unknown): unknown {
  const record = objectPayload(payload);
  return record?.["egress"] ?? record?.["telegram"] ?? null;
}

function asTurnInputPayload(work: LeasedWorkItem): UserTurnPayload {
  const message = preparedMessage(work.payload);
  if (message) {
    return {
      input: inputFromMessage(message),
      message,
      ...(egressTarget(work.payload) !== null ? { egress: egressTarget(work.payload) } : {}),
    };
  }
  return {
    input: { text: workText(work.payload) },
    ...(egressTarget(work.payload) !== null ? { egress: egressTarget(work.payload) } : {}),
  };
}

/** Durable orchestration boundary for a single leased work item. */
export class TurnRunner {
  private readonly _egressOutbox: EgressOutbox;
  private readonly _queue: WorkQueue;
  private readonly _context: SessionContextEngine;
  private readonly _egress: EgressPort;
  private readonly _tools: TurnRunnerOptions["tools"];
  private readonly _baseSystemPrompt: TurnRunnerOptions["baseSystemPrompt"];
  private readonly _guardToolCall: TurnRunnerOptions["guardToolCall"];
  private readonly _observer: TurnRunnerOptions["observer"];
  private readonly _fallbackText: TurnRunnerOptions["fallbackText"];

  /** Creates a turn runner. */
  constructor(options: TurnRunnerOptions) {
    this._egressOutbox = new EgressOutbox(options.events);
    this._queue = options.queue;
    this._context = options.context;
    this._egress = options.egress;
    this._tools = options.tools;
    this._baseSystemPrompt = options.baseSystemPrompt;
    this._guardToolCall = options.guardToolCall;
    this._observer = options.observer;
    this._fallbackText = options.fallbackText;
  }

  /** Runs one leased work item through projection, model execution, egress, and completion. */
  async run(work: LeasedWorkItem, options: RunTurnWorkOptions): Promise<TurnRunnerResult> {
    try {
      const baseSystemPrompt = await this._baseSystemPrompt(work);
      const output = await this._context.runModelTurn({
        sessionId: work.sessionId,
        workId: work.id,
        inputPayload: asTurnInputPayload(work),
        inputPolicy: "ensure",
        baseSystemPrompt,
        tools: [...await this._tools(work)] as Tool[],
        guardToolCall: await this._guardToolCall?.(work),
        signal: options.signal,
        observer: await this._observer?.(work),
      });
      let finalization: FinalizeSessionTurnResult | undefined;
      let finalizationError: string | undefined;
      try {
        finalization = await this._context.finalizeTurn({
          sessionId: work.sessionId,
          baseSystemPrompt,
        });
      } catch (error) {
        finalizationError = errorMessage(error);
      }

      const fallbackText = output.replyTexts.length === 0 ? await this._fallbackText?.(work) : undefined;
      if (output.replyTexts.length > 0 || fallbackText !== undefined) {
        await this._sendEgress(work, output.replyTexts, fallbackText);
      }
      await this._queue.complete(work.id, {
        leaseId: work.lease.id,
      });
      return {
        ...output,
        ...(finalization !== undefined ? { finalization } : {}),
        ...(finalizationError !== undefined ? { finalizationError } : {}),
      };
    } catch (error) {
      if (isAbortError(error)) {
        const disposition = typeof options.abortDisposition === "function" ?
          options.abortDisposition(work, error) :
          options.abortDisposition ?? "cancel";
        if (disposition === "release") {
          await this._queue.release(work.id, {
            leaseId: work.lease.id,
          });
        } else {
          await this._queue.cancel(work.id, {
            reason: errorMessage(error),
          });
        }
        throw error;
      }
      await this._queue.fail(work.id, {
        leaseId: work.lease.id,
        reason: errorMessage(error),
      });
      throw error;
    }
  }

  /** Sends assistant replies through the egress port with queued/sent events around the side effect. */
  private async _sendEgress(work: LeasedWorkItem, replies: string[], fallbackText?: string): Promise<void> {
    const payload: EgressPayload = {
      workId: work.id,
      sessionId: work.sessionId,
      target: egressTarget(work.payload),
      replies,
      ...(fallbackText !== undefined ? { fallbackText } : {}),
    };
    const queued = await this._egressOutbox.queue({
      workId: work.id,
      sessionId: work.sessionId,
      target: payload.target,
      replies: payload.replies,
      ...(fallbackText !== undefined ? { fallbackText } : {}),
    });
    await this._egress.send(payload);
    await this._egressOutbox.markSent({
      workId: work.id,
      sessionId: work.sessionId,
      payload: queued.payload,
    });
  }
}
