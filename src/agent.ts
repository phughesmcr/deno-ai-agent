import type { Tool } from "@lmstudio/sdk";

import { ChatContext } from "./context/chat-context.ts";
import { createSummaryCompactor } from "./context/compactor.ts";
import { SessionStore } from "./context/session-store.ts";
import { SessionManager } from "./context/session.ts";
import type { LMStudioManager } from "./lmstudio.ts";
import { createActSpanTracker, tokenBucket, traceSpan } from "./otel.ts";
import type { Workspace } from "./workspace.ts";

export interface Agent {
  readonly session: SessionManager;
  readonly lmstudio: LMStudioManager;
}

interface CreateAgentOptions {
  workspace: Workspace;
  lmstudio: LMStudioManager;
  maxContextLength: number;
  signal: AbortSignal;
}

/** Wires workspace, LM Studio chat context, and session persistence. */
export async function createAgent(spec: CreateAgentOptions): Promise<Agent> {
  const { workspace, lmstudio, maxContextLength, signal } = spec;

  const chat = new ChatContext({
    model: lmstudio.model,
    maxContextLength,
    compactor: createSummaryCompactor(lmstudio.model, signal),
  });

  const store = new SessionStore(workspace.sessionsDir);
  const session = new SessionManager({ chat, store, workspace });

  await session.applySystemPrompt(workspace.systemPrompt);

  workspace.subscribeToFsEvents(async (event) => {
    if (event.kind === "modify" && event.paths.at(-1)?.endsWith("SYSTEM.md")) {
      const prompt = await workspace.reloadSystemPrompt();
      await session.applySystemPrompt(prompt);
    }
  });

  return { session, lmstudio };
}

export interface TurnResult {
  replyTexts: string[];
  turnTokens: number;
  compacted: boolean;
  totalTokens: number;
}

interface RunTurnOptions {
  tools: Tool[];
  signal: AbortSignal;
}

/** Appends the user message, runs `model.act`, finalizes context. */
export async function runTurn(agent: Agent, userText: string, options: RunTurnOptions): Promise<TurnResult> {
  const { session, lmstudio } = agent;
  const { tools, signal } = options;

  session.appendUser(userText);

  const replyTexts: string[] = [];
  const turnTokenCounts: Promise<number>[] = [];
  const actStarted = performance.now();
  let firstTokenMs: number | undefined;
  let replies = 0;
  let turnTokens = 0;

  await traceSpan(
    "lmstudio.act",
    async (actSpan) => {
      const actTelemetry = createActSpanTracker();

      await lmstudio.model.act(session.chat.snapshot(), tools, {
        onMessage: (msg) => {
          actTelemetry.onMessage();
          replies++;
          const assistant = session.appendAssistant(msg);
          turnTokenCounts.push(lmstudio.model.countTokens(assistant.toString()));
          replyTexts.push(msg.getText());
        },
        onFirstToken: (roundIndex) => {
          const ms = performance.now() - actStarted;
          if (firstTokenMs === undefined) firstTokenMs = ms;
          actTelemetry.onFirstToken(roundIndex, ms);
        },
        onRoundStart: (roundIndex) => actTelemetry.onRoundStart(roundIndex),
        onRoundEnd: (roundIndex) => actTelemetry.onRoundEnd(roundIndex),
        onToolCallRequestDequeued: (roundIndex, callId) => {
          actTelemetry.onToolCallRequestDequeued(roundIndex, callId);
        },
        onToolCallRequestEnd: (roundIndex, callId, info) => {
          actTelemetry.onToolCallRequestEnd(roundIndex, callId, info.toolCallRequest.name, info.isQueued);
        },
        onToolCallRequestFailure: (_roundIndex, callId, error) => {
          actTelemetry.onToolCallRequestFailure(callId, error.message);
        },
        onToolCallRequestFinalized: (_roundIndex, callId, info) => {
          actTelemetry.onToolCallRequestFinalized(callId, info.toolCallRequest.name);
        },
        onToolCallRequestNameReceived: (_roundIndex, callId, name) => {
          actTelemetry.onToolCallRequestNameReceived(callId, name);
        },
        onToolCallRequestStart: (roundIndex, callId, info) => {
          actTelemetry.onToolCallRequestStart(roundIndex, callId, info.toolCallId);
        },
        signal,
      });

      turnTokens = (await Promise.all(turnTokenCounts)).reduce((sum, n) => sum + n, 0);
      actSpan.setAttribute("context.tokens", tokenBucket(turnTokens));
      actSpan.setAttribute("reply.count", replies);
      if (firstTokenMs !== undefined) actSpan.setAttribute("first_token.ms", Math.round(firstTokenMs));
    },
    { attributes: { "tools.count": tools.length } },
  );

  const { tokenCount, compacted } = await session.finalizeTurn();

  return {
    replyTexts,
    turnTokens,
    compacted,
    totalTokens: tokenCount,
  };
}
