import type { ChatMessageData, Tool } from "@lmstudio/sdk";

import { createModelActObserver, recordActDuration, tokenBucket, userTurnImageCount } from "../agent/mod.ts";
import type { AgentModelActPort } from "../agent/model-act.ts";
import type { EventStore, LeasedWorkItem, ModelTurnRequest, SessionContextEngine, WorkQueue } from "../core/mod.ts";
import { errorMessage, isAbortError, logDebug, logInfo, traceSpan } from "../shared/mod.ts";
import type { TelegramCapabilityTurnContext } from "../telegram/capability-prompt.ts";
import { createTelegramTurnEgressPort, runQueuedPreparedTurn } from "./queued-turn-runner.ts";
import type { TelegramEgressApi } from "./telegram-egress.ts";

/** Shared Telegram send adapter for queued turn egress. */
export interface TelegramSendApi {
  sendMessage: TelegramEgressApi["sendMessage"];
}

/** Creates a send adapter from a GrammY bot API surface. */
export function createTelegramSendApi(api: {
  sendMessage: TelegramEgressApi["sendMessage"];
}): TelegramSendApi {
  return { sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options) };
}

/** Mutable hook for waking the queue worker before it is constructed. */
export interface QueueWakeRef {
  wake(): void;
}

/** Active turn registry surface used by queued Telegram turns. */
export interface QueuedTurnActiveTurns {
  setActiveTurn(input: {
    id: string;
    actController: AbortController;
    approvalController: AbortController;
  }): () => void;
}

/** Capability and broker prompt ports used during queued turns. */
export interface QueuedTurnPromptPorts {
  setTurnContext(input: { ctx: TelegramCapabilityTurnContext; signal: AbortSignal }): void;
  clearTurnContext(): void;
  abortPending(): void;
}

/** Prepared model turn inputs for one queued Telegram work item. */
export interface PreparedQueuedTelegramTurn {
  userMessage: ChatMessageData;
  tools: readonly Tool[];
  guardToolCall?: ModelTurnRequest["guardToolCall"];
  fallbackText: string;
  startedLog: string;
  finishedLog: (replyCount: number) => string;
}

/** Options for running one queued Telegram turn through the durable core. */
export interface RunQueuedTelegramTurnOptions {
  work: LeasedWorkItem;
  signal: AbortSignal;
  ctx: TelegramCapabilityTurnContext;
  events: EventStore;
  queue: WorkQueue;
  context: SessionContextEngine;
  modelAct: Pick<AgentModelActPort, "countTokens">;
  workspaceSystemPrompt: string;
  sendApi: TelegramSendApi;
  activeTurns: QueuedTurnActiveTurns;
  capabilityPrompts: QueuedTurnPromptPorts;
  brokerPermissionPrompts: Pick<QueuedTurnPromptPorts, "abortPending">;
  setActiveTurnId(id: string): void;
  clearActiveTurnId(): void;
  beforeAct?(input: { runSignal: AbortSignal; approvalSignal: AbortSignal }): void;
  runSessionWork(
    runAct: (prepared: PreparedQueuedTelegramTurn) => Promise<void>,
  ): Promise<void>;
  cancelReason?: string;
  onActError?(error: unknown): Promise<void>;
  onFinally?(): Promise<void>;
}

async function settleQueuedTurnError(
  work: LeasedWorkItem,
  queue: WorkQueue,
  signal: AbortSignal,
  turnController: AbortController,
  error: unknown,
  cancelReason: string,
): Promise<void> {
  const current = await queue.get(work.id);
  if (current?.status !== "leased" || current.lease?.id !== work.lease.id) return;
  if (isAbortError(error) && turnController.signal.aborted && !signal.aborted) {
    await queue.cancel(work.id, { reason: cancelReason });
  } else if (isAbortError(error) && signal.aborted) {
    await queue.release(work.id, { leaseId: work.lease.id });
  } else {
    await queue.fail(work.id, {
      leaseId: work.lease.id,
      reason: errorMessage(error),
    });
  }
}

/** Runs the shared queued Telegram turn skeleton used by user and cron work. */
export async function runQueuedTelegramTurn(options: RunQueuedTelegramTurnOptions): Promise<void> {
  const turnController = new AbortController();
  const approvalController = new AbortController();
  const onShutdown = (): void => {
    turnController.abort();
    approvalController.abort();
  };
  options.signal.addEventListener("abort", onShutdown);
  options.setActiveTurnId(options.work.id);
  const clearActiveTurn = options.activeTurns.setActiveTurn({
    id: options.work.id,
    actController: turnController,
    approvalController,
  });
  const runSignal = AbortSignal.any([options.signal, turnController.signal]);
  options.beforeAct?.({ runSignal, approvalSignal: approvalController.signal });
  options.capabilityPrompts.setTurnContext({ ctx: options.ctx, signal: approvalController.signal });
  const actStarted = performance.now();
  let completed = false;
  try {
    await options.runSessionWork(async (prepared) => {
      logInfo(prepared.startedLog);
      const result = await traceSpan(
        "lmstudio.act",
        async (actSpan) => {
          const observer = createModelActObserver();
          const imageCount = userTurnImageCount(prepared.userMessage);
          if (imageCount > 0) actSpan.setAttribute("user.images.count", imageCount);
          const turnResult = await runQueuedPreparedTurn({
            events: options.events,
            queue: options.queue,
            context: options.context,
            egress: createTelegramTurnEgressPort({ sendMessage: options.sendApi.sendMessage }),
            baseSystemPrompt: options.workspaceSystemPrompt,
            work: options.work,
            userMessage: prepared.userMessage,
            tools: prepared.tools,
            guardToolCall: prepared.guardToolCall,
            observer,
            signal: runSignal,
            abortDisposition: () => options.signal.aborted ? "release" : "cancel",
            fallbackText: prepared.fallbackText,
          });
          const turnTokens = (await options.modelAct.countTokens(turnResult.persistedMessages))
            .reduce((sum, count) => sum + count, 0);
          if (turnResult.finalization) {
            actSpan.setAttribute("context.tokens", tokenBucket(turnResult.finalization.totalTokens));
          }
          actSpan.setAttribute("turn.tokens", tokenBucket(turnTokens));
          actSpan.setAttribute("reply.count", turnResult.replyTexts.length);
          if (turnResult.firstTokenMs !== undefined) {
            actSpan.setAttribute("first_token.ms", Math.round(turnResult.firstTokenMs));
          }
          return turnResult;
        },
        { attributes: { "tools.count": prepared.tools.length } },
      );
      logInfo(prepared.finishedLog(result.replyTexts.length));
      if (result.finalization?.compacted) {
        logDebug("session.compacted", { sessionId: options.work.sessionId });
      }
    });
    completed = true;
  } catch (error) {
    await settleQueuedTurnError(
      options.work,
      options.queue,
      options.signal,
      turnController,
      error,
      options.cancelReason ?? "Turn aborted.",
    );
    await options.onActError?.(error);
    throw error;
  } finally {
    recordActDuration(performance.now() - actStarted, completed ? "ok" : "error");
    clearActiveTurn();
    options.signal.removeEventListener("abort", onShutdown);
    if (!completed) {
      approvalController.abort();
      options.brokerPermissionPrompts.abortPending();
      options.capabilityPrompts.abortPending();
    }
    options.capabilityPrompts.clearTurnContext();
    options.clearActiveTurnId();
    await options.onFinally?.();
  }
}
