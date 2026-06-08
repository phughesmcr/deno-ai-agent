import * as path from "@std/path";

import { type EventStore, KvEventStore, KvSessionCatalog, SessionContextEngine } from "../core/mod.ts";
import { type AgentSessions, DurableAgentSessions } from "./context/session.ts";
import type { LMStudioManager } from "./lmstudio.ts";
import { type AgentModelActPort, LmStudioAgentModelAct } from "./model-act.ts";
import type { Workspace } from "./workspace.ts";

/** Returns whether a filesystem event should reload the workspace system prompt. */
export function isSystemPromptModifyEvent(event: Deno.FsEvent): boolean {
  return event.kind === "modify" && event.paths.some((eventPath) => path.basename(eventPath) === "SYSTEM.md");
}

/** Wired agent: session state and LM Studio model. */
export interface Agent {
  /** Conversation sessions facade. */
  readonly sessions: AgentSessions;
  /** Shared durable session context engine. */
  readonly context: SessionContextEngine;
  /** Central model-act boundary for turns, summaries, and subagents. */
  readonly modelAct: AgentModelActPort;
  /** LM Studio client and model. */
  readonly lmstudio: LMStudioManager;
}

/** Options for {@link createAgent}. */
export interface CreateAgentOptions {
  /** Workspace directory and system prompt. */
  workspace: Workspace;
  /** Shared persistent workspace KV for non-log application state. */
  kv: Deno.Kv;
  /** Shared durable event store, when app composition already owns one. */
  events?: EventStore;
  /** Connected LM Studio client and model. */
  lmstudio: LMStudioManager;
  /** Model context window size. */
  maxContextLength: number;
  /** Abort signal for startup operations. */
  signal: AbortSignal;
}

/** Wires workspace, LM Studio chat context, and session persistence. */
export async function createAgent(spec: CreateAgentOptions): Promise<Agent> {
  const { workspace, kv, lmstudio, maxContextLength, signal } = spec;

  const events = spec.events ?? new KvEventStore(kv);
  const catalog = new KvSessionCatalog(kv);
  const modelAct = new LmStudioAgentModelAct({
    client: lmstudio.client,
    model: lmstudio.model,
    signal,
  });
  const context = new SessionContextEngine({
    events,
    model: modelAct,
    summary: modelAct,
    maxContextLength,
  });
  const sessions = new DurableAgentSessions({
    events,
    catalog,
    context,
    systemPrompt: workspace.systemPrompt,
    maxContextLength,
  });

  await sessions.status({ refresh: true });

  workspace.subscribeToFsEvents(async (event) => {
    if (isSystemPromptModifyEvent(event)) {
      const prompt = await workspace.reloadSystemPrompt();
      await sessions.applySystemPrompt(prompt);
    }
  });

  return { sessions, context, modelAct, lmstudio };
}
