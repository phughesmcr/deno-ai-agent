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
}

/** Typed model input supplied by the app adapter. */
export interface TurnRunnerInput {
  /** User message to append to projected session context. */
  message: ChatMessageData;
  /** Auditable summary stored with the durable input event. */
  audit: {
    /** User-visible text extracted by the adapter. */
    text: string;
    /** Number of attached images, when any. */
    imageCount?: number;
  };
}

/** Typed egress target supplied by the app adapter. */
export interface TurnRunnerEgress {
  /** Adapter-owned reply target. */
  target: unknown;
}

/** Options for running one leased turn. */
export interface RunTurnWorkOptions {
  /** Abort signal for the active turn. */
  signal: AbortSignal;
  /** Prepared typed input. */
  input: TurnRunnerInput;
  /** Prepared egress target. */
  egress: TurnRunnerEgress;
  /** Fallback text to send when a completed model turn produced no reply chunks. */
  fallbackText?: string;
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

function turnInputPayload(input: TurnRunnerInput): unknown {
  return {
    input: input.audit,
    message: input.message,
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
  }

  /** Runs one leased work item through projection, model execution, egress, and completion. */
  async run(work: LeasedWorkItem, options: RunTurnWorkOptions): Promise<TurnRunnerResult> {
    try {
      const baseSystemPrompt = await this._baseSystemPrompt(work);
      const output = await this._context.runModelTurn({
        sessionId: work.sessionId,
        workId: work.id,
        inputPayload: turnInputPayload(options.input),
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

      const fallbackText = output.replyTexts.length === 0 ? options.fallbackText : undefined;
      if (output.replyTexts.length > 0 || fallbackText !== undefined) {
        await this._sendEgress(work, options.egress, output.replyTexts, fallbackText);
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
  private async _sendEgress(
    work: LeasedWorkItem,
    egress: TurnRunnerEgress,
    replies: string[],
    fallbackText?: string,
  ): Promise<void> {
    const payload: EgressPayload = {
      workId: work.id,
      sessionId: work.sessionId,
      target: egress.target,
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
