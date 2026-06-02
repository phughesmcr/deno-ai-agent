import type { Tool } from "@lmstudio/sdk";

import { createSummaryCompactor } from "./context/compactor.ts";
import { SessionStore } from "./context/session-store.ts";
import { type ModelActObserver, SessionManager, type SessionTurnResult } from "./context/session.ts";
import type { LMStudioManager } from "./lmstudio.ts";
import { createActSpanTracker, tokenBucket, traceSpan } from "../shared/otel.ts";
import type { Workspace } from "./workspace.ts";

/** Wired agent: session state and LM Studio model. */
export interface Agent {
  /** Conversation session manager. */
  readonly session: SessionManager;
  /** LM Studio client and model. */
  readonly lmstudio: LMStudioManager;
}

/** Options for {@link createAgent}. */
export interface CreateAgentOptions {
  /** Workspace directory and system prompt. */
  workspace: Workspace;
  /** Connected LM Studio client and model. */
  lmstudio: LMStudioManager;
  /** Model context window size. */
  maxContextLength: number;
  /** Abort signal for startup operations. */
  signal: AbortSignal;
}

/** Wires workspace, LM Studio chat context, and session persistence. */
export async function createAgent(spec: CreateAgentOptions): Promise<Agent> {
  const { workspace, lmstudio, maxContextLength, signal } = spec;

  const store = new SessionStore(workspace.sessionsDir);
  const session = new SessionManager({
    model: lmstudio.model,
    store,
    systemPrompt: workspace.systemPrompt,
    maxContextLength,
    compactor: createSummaryCompactor(lmstudio.model, signal),
  });

  await session.refreshStatus();

  workspace.subscribeToFsEvents(async (event) => {
    if (event.kind === "modify" && event.paths.at(-1)?.endsWith("SYSTEM.md")) {
      const prompt = await workspace.reloadSystemPrompt();
      await session.applySystemPrompt(prompt);
    }
  });

  return { session, lmstudio };
}

/** Result of a single user turn through the model. */
export type TurnResult = SessionTurnResult;

/** Options for one model turn. */
export interface RunTurnOptions {
  /** Tools available to the model during this turn. */
  tools: Tool[];
  /** Signal that cancels the active turn. */
  signal: AbortSignal;
}

/**
 * Runs one user turn with telemetry around the session-owned model act.
 * @internal
 */
export async function runTurn(agent: Agent, userText: string, options: RunTurnOptions): Promise<TurnResult> {
  const { session } = agent;
  const { tools, signal } = options;

  let firstTokenMs: number | undefined;
  let result: SessionTurnResult | undefined;

  await traceSpan(
    "lmstudio.act",
    async (actSpan) => {
      const actTelemetry = createActSpanTracker();
      const observer: ModelActObserver = {
        onMessage: () => actTelemetry.onMessage(),
        onFirstToken: (roundIndex, ms) => {
          if (firstTokenMs === undefined && ms !== undefined) firstTokenMs = ms;
          actTelemetry.onFirstToken(roundIndex, ms);
        },
        onRoundStart: (roundIndex) => actTelemetry.onRoundStart(roundIndex),
        onRoundEnd: (roundIndex) => actTelemetry.onRoundEnd(roundIndex),
        onToolCallRequestDequeued: (roundIndex, callId) => {
          actTelemetry.onToolCallRequestDequeued(roundIndex, callId);
        },
        onToolCallRequestEnd: (roundIndex, callId, name, isQueued) => {
          actTelemetry.onToolCallRequestEnd(roundIndex, callId, name, isQueued);
        },
        onToolCallRequestFailure: (callId, message) => {
          actTelemetry.onToolCallRequestFailure(callId, message);
        },
        onToolCallRequestFinalized: (callId, name) => {
          actTelemetry.onToolCallRequestFinalized(callId, name);
        },
        onToolCallRequestNameReceived: (callId, name) => {
          actTelemetry.onToolCallRequestNameReceived(callId, name);
        },
        onToolCallRequestStart: (roundIndex, callId, toolCallId) => {
          actTelemetry.onToolCallRequestStart(roundIndex, callId, toolCallId);
        },
      };

      result = await session.runTurn(userText, {
        tools,
        signal,
        observer,
      });

      actSpan.setAttribute("context.tokens", tokenBucket(result.totalTokens));
      actSpan.setAttribute("turn.tokens", tokenBucket(result.turnTokens));
      actSpan.setAttribute("reply.count", result.replyTexts.length);
      if (firstTokenMs !== undefined) actSpan.setAttribute("first_token.ms", Math.round(firstTokenMs));
    },
    { attributes: { "tools.count": tools.length } },
  );

  if (!result) throw new Error("Session turn did not complete");
  return result;
}
