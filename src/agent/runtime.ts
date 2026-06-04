import type { Tool } from "@lmstudio/sdk";

import { traceSpan } from "../shared/otel.ts";
import { createModelActObserver, tokenBucket } from "./act-telemetry.ts";
import { SessionStore } from "./context/session-store.ts";
import { type AgentSessions, PersistentAgentSessions, type SessionTurnResult } from "./context/session.ts";
import type { LMStudioManager } from "./lmstudio.ts";
import { type AgentModelActPort, LmStudioAgentModelAct } from "./model-act.ts";
import type { ToolCallGuard } from "./tools/authorization.ts";
import { normalizeUserTurnInput, type UserTurnInput } from "./user-turn.ts";
import type { Workspace } from "./workspace.ts";

/** Wired agent: session state and LM Studio model. */
export interface Agent {
  /** Conversation sessions facade. */
  readonly sessions: AgentSessions;
  /** Central model-act boundary for turns, summaries, and subagents. */
  readonly modelAct: AgentModelActPort;
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
  const modelAct = new LmStudioAgentModelAct({
    client: lmstudio.client,
    model: lmstudio.model,
    signal,
  });
  const sessions = new PersistentAgentSessions({
    model: modelAct,
    store,
    systemPrompt: workspace.systemPrompt,
    maxContextLength,
    summary: modelAct,
  });

  await sessions.status({ refresh: true });

  workspace.subscribeToFsEvents(async (event) => {
    if (event.kind === "modify" && event.paths.at(-1)?.endsWith("SYSTEM.md")) {
      const prompt = await workspace.reloadSystemPrompt();
      await sessions.applySystemPrompt(prompt);
    }
  });

  return { sessions, modelAct, lmstudio };
}

/** Result of a single user turn through the model. */
export type TurnResult = SessionTurnResult;

/** Options for one model turn. */
export interface RunTurnOptions {
  /** Tools available to the model during this turn. */
  tools: Tool[];
  /** App-level guard for approving or denying model tool calls. */
  guardToolCall?: ToolCallGuard;
  /** Signal that cancels the active turn. */
  signal: AbortSignal;
}

/**
 * Runs one user turn with telemetry around the session-owned model act.
 * @internal
 */
export async function runTurn(
  agent: Agent,
  userInput: string | UserTurnInput,
  options: RunTurnOptions,
): Promise<TurnResult> {
  const { sessions } = agent;
  const { tools, guardToolCall, signal } = options;
  const input = normalizeUserTurnInput(userInput);

  let result: SessionTurnResult | undefined;

  await traceSpan(
    "lmstudio.act",
    async (actSpan) => {
      const observer = createModelActObserver();
      const imageCount = input.images?.length ?? 0;
      if (imageCount > 0) actSpan.setAttribute("user.images.count", imageCount);

      result = await sessions.turn(input, {
        tools,
        guardToolCall,
        signal,
        observer,
      });

      actSpan.setAttribute("context.tokens", tokenBucket(result.totalTokens));
      actSpan.setAttribute("turn.tokens", tokenBucket(result.turnTokens));
      actSpan.setAttribute("reply.count", result.replyTexts.length);
      if (result.firstTokenMs !== undefined) actSpan.setAttribute("first_token.ms", Math.round(result.firstTokenMs));
    },
    { attributes: { "tools.count": tools.length } },
  );

  if (!result) throw new Error("Session turn did not complete");
  return result;
}
