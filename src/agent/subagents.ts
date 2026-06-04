import { Chat, type Tool } from "@lmstudio/sdk";

import { getActMaxPredictionRounds } from "../shared/act-config.ts";
import { getActDraftModel } from "../shared/draft-model.ts";
import { type ActReasoningParsing, actReasoningParsingOption, persistedModelText } from "../shared/reasoning.ts";
import type { SkillManager } from "./skills/mod.ts";
import type { ToolContext } from "./tools/context.ts";
import { createFindTool } from "./tools/find.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createLsTool } from "./tools/ls.ts";
import { createReadTool } from "./tools/read.ts";
import { createSkillTool } from "./tools/skill.ts";
import { withRecoverableToolErrors } from "./tools/tool-errors.ts";

/** Subagent lifecycle state stored in KV. */
export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Session-scoped subagent job record. */
export interface SubagentRecord {
  /** Subagent job id. */
  id: string;
  /** Parent conversation session id. */
  sessionId: string;
  /** Short display title. */
  title: string;
  /** Full task prompt sent to the subagent. */
  task: string;
  /** Current lifecycle status. */
  status: SubagentStatus;
  /** ISO timestamp when the job was created. */
  createdAt: string;
  /** ISO timestamp when model execution started. */
  startedAt?: string;
  /** ISO timestamp when the job reached a terminal state. */
  finishedAt?: string;
  /** Final assistant text for completed jobs. */
  result?: string;
  /** Error text for failed or cancelled jobs. */
  error?: string;
}

/** Spawn request for a read-only subagent job. */
export interface SubagentSpawnSpec {
  /** Task prompt for the subagent. */
  task: string;
  /** Optional short display title. */
  title?: string;
}

/** Read-only subagent operations exposed to the `subagent` tool. */
export interface SubagentPort {
  /** Creates an async queued subagent job. */
  spawn(spec: SubagentSpawnSpec): Promise<SubagentRecord>;
  /** Returns a subagent in the current session by id. */
  status(agentId: string): Promise<SubagentRecord | undefined>;
  /** Lists subagents for the current session. */
  list(): Promise<SubagentRecord[]>;
  /** Returns a subagent record, including result or error when terminal. */
  result(agentId: string): Promise<SubagentRecord | undefined>;
  /** Cancels a queued or running subagent, returning the current record. */
  cancel(agentId: string): Promise<SubagentRecord | undefined>;
}

/** Minimal message shape observed from LM Studio `act()` callbacks. */
export interface SubagentActMessage {
  /** Message role, such as `assistant` or `tool`. */
  getRole(): string;
  /** Plain text content for assistant messages. */
  getText(): string;
}

/** Minimal options accepted by the subagent model adapter. */
export interface SubagentActOptions {
  /** Whether to allow parallel tool execution. */
  allowParallelToolExecution?: boolean;
  /** What to do when the context overflows. */
  contextOverflowPolicy?: "truncateMiddle" | "stopAtLimit" | "rollingWindow";
  /** Maximum number of tokens to generate. */
  maxTokens?: number;
  /** Maximum number of prediction rounds to allow. */
  maxPredictionRounds?: number;
  /** LM Studio reasoning delimiter parsing (see `getActReasoningParsing`). */
  reasoningParsing?: ActReasoningParsing;
  /** Called for each emitted message. */
  onMessage?: (message: SubagentActMessage) => void;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

/** Minimal structural model interface needed to run a subagent chat. */
export interface SubagentModel {
  /** Runs one model act over a chat-like object and model tools. */
  act(chat: unknown, tools: Tool[], options: SubagentActOptions): Promise<unknown>;
}

/** Options for {@link SubagentManager}. */
export interface SubagentManagerOptions {
  /** Deno KV store used for process-local records. */
  kv: Deno.Kv;
  /** LM Studio model or compatible chat model. */
  model: SubagentModel;
  /** Workspace used by read-only child tools. */
  workspace: ToolContext;
  /** Skill catalog shared with the parent process. */
  skills: SkillManager;
  /** Returns the current parent session id. */
  getSessionId: () => string;
}

interface SubagentRef {
  sessionId: string;
  agentId: string;
}

const SUBAGENT_SYSTEM_PROMPT = [
  "You are a read-only research subagent for a parent coding agent.",
  "Inspect the workspace and report concise findings for the requested task.",
  "You may use only read, grep, find, ls, and skill.",
  "Do not modify files, run shell commands, ask the user questions, manage todos, or spawn other agents.",
  "Return a final answer with relevant file paths and line references where useful.",
].join("\n");

function nowIso(): string {
  return new Date().toISOString();
}

function defaultTitle(task: string): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 80) || "Subagent task";
}

function isTerminal(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error("Subagent manager is not configured for this process."));
}

/** Port for tests and non-runtime tool construction where no model is available. */
export function createUnavailableSubagentPort(): SubagentPort {
  return {
    spawn: () => unavailable(),
    status: () => unavailable(),
    list: () => unavailable(),
    result: () => unavailable(),
    cancel: () => unavailable(),
  };
}

/** Builds the read-only tool set available inside subagent jobs. */
export function createReadOnlySubagentTools(workspace: ToolContext, skills: SkillManager): Tool[] {
  return [
    createReadTool(workspace),
    createGrepTool(workspace),
    createFindTool(workspace),
    createLsTool(workspace),
    createSkillTool(skills, workspace),
  ].map(withRecoverableToolErrors);
}

/**
 * Async, process-local subagent job manager backed by session-scoped Deno KV records.
 * Active controllers and queue state are intentionally in memory only.
 */
export class SubagentManager implements SubagentPort {
  readonly #kv: Deno.Kv;
  readonly #model: SubagentModel;
  readonly #workspace: ToolContext;
  readonly #skills: SkillManager;
  readonly #getSessionId: () => string;

  #queue: SubagentRef[] = [];
  #activeControllers = new Map<string, AbortController>();
  #running = false;
  #currentRun: Promise<void> | undefined;
  #closed = false;

  /** Creates a session-scoped subagent manager over a Deno KV store. */
  constructor(options: SubagentManagerOptions) {
    this.#kv = options.kv;
    this.#model = options.model;
    this.#workspace = options.workspace;
    this.#skills = options.skills;
    this.#getSessionId = options.getSessionId;
  }

  /** Creates a queued subagent job and schedules it for async execution. */
  async spawn(spec: SubagentSpawnSpec): Promise<SubagentRecord> {
    if (this.#closed) throw new Error("Subagent manager is shutting down.");

    const task = spec.task.trim();
    const sessionId = this.#getSessionId();
    const record: SubagentRecord = {
      id: crypto.randomUUID(),
      sessionId,
      title: spec.title?.trim() || defaultTitle(task),
      task,
      status: "queued",
      createdAt: nowIso(),
    };

    await this.#put(record);
    this.#queue.push({ sessionId, agentId: record.id });
    this.#scheduleNext();
    return record;
  }

  /** Returns a subagent in the current session by id. */
  status(agentId: string): Promise<SubagentRecord | undefined> {
    return this.#get(this.#getSessionId(), agentId);
  }

  /** Lists subagents in the current session ordered by creation time. */
  async list(): Promise<SubagentRecord[]> {
    const sessionId = this.#getSessionId();
    const records: SubagentRecord[] = [];
    const iterator = this.#kv.list<SubagentRecord>({ prefix: ["subagents", sessionId] });
    for await (const entry of iterator) {
      records.push(entry.value);
    }
    return records.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Returns a subagent record, including terminal result or error when present. */
  result(agentId: string): Promise<SubagentRecord | undefined> {
    return this.status(agentId);
  }

  /** Cancels a queued or running job; terminal jobs are returned unchanged. */
  async cancel(agentId: string): Promise<SubagentRecord | undefined> {
    const sessionId = this.#getSessionId();
    const record = await this.#get(sessionId, agentId);
    if (!record) return undefined;
    if (isTerminal(record.status)) return record;

    const ref = { sessionId, agentId };
    if (record.status === "queued") {
      this.#queue = this.#queue.filter((item) => this.#refKey(item) !== this.#refKey(ref));
    }

    this.#activeControllers.get(this.#refKey(ref))?.abort();
    return await this.#markCancelled(ref, record);
  }

  /** Aborts active work and prevents queued work from starting. */
  async shutdown(): Promise<void> {
    this.#closed = true;
    const queued = this.#queue;
    this.#queue = [];

    for (const controller of this.#activeControllers.values()) {
      controller.abort();
    }

    await Promise.all(queued.map(async (ref) => {
      const record = await this.#get(ref.sessionId, ref.agentId);
      if (record && record.status === "queued") {
        await this.#markCancelled(ref, record);
      }
    }));

    await this.#currentRun?.catch(() => {});
  }

  #scheduleNext(): void {
    if (this.#closed || this.#running) return;
    const next = this.#queue.shift();
    if (!next) return;

    this.#running = true;
    const run = this.#runQueuedJob(next)
      .catch(() => {})
      .finally(() => {
        this.#running = false;
        this.#currentRun = undefined;
        this.#scheduleNext();
      });
    this.#currentRun = run;
  }

  async #runQueuedJob(ref: SubagentRef): Promise<void> {
    const record = await this.#get(ref.sessionId, ref.agentId);
    if (!record || record.status !== "queued") return;

    const runningRecord: SubagentRecord = {
      ...record,
      status: "running",
      startedAt: nowIso(),
    };
    await this.#put(runningRecord);

    const controller = new AbortController();
    this.#activeControllers.set(this.#refKey(ref), controller);

    try {
      const result = await this.#runModel(record.task, controller.signal);
      const latest = await this.#get(ref.sessionId, ref.agentId) ?? runningRecord;
      if (latest.status === "cancelled" || controller.signal.aborted) {
        await this.#markCancelled(ref, latest);
        return;
      }
      await this.#put({
        ...latest,
        status: "completed",
        finishedAt: nowIso(),
        result,
      });
    } catch (error) {
      const latest = await this.#get(ref.sessionId, ref.agentId) ?? runningRecord;
      if (latest.status === "cancelled" || isAbortError(error, controller.signal)) {
        await this.#markCancelled(ref, latest);
        return;
      }
      await this.#put({
        ...latest,
        status: "failed",
        finishedAt: nowIso(),
        error: errorMessage(error),
      });
    } finally {
      this.#activeControllers.delete(this.#refKey(ref));
    }
  }

  async #runModel(task: string, signal: AbortSignal): Promise<string> {
    await this.#skills.refresh();

    const chat = Chat.empty();
    chat.replaceSystemPrompt(SUBAGENT_SYSTEM_PROMPT);
    chat.append("user", task);

    let result = "";
    await this.#model.act(chat, createReadOnlySubagentTools(this.#workspace, this.#skills), {
      ...(getActDraftModel() ?? {}),
      ...actReasoningParsingOption(),
      allowParallelToolExecution: true,
      contextOverflowPolicy: "truncateMiddle",
      maxTokens: 4096,
      maxPredictionRounds: getActMaxPredictionRounds(),
      onMessage: (message) => {
        if (message.getRole() !== "assistant") return;
        const text = message.getText();
        if (text) result = persistedModelText(text);
      },
      signal,
    });
    return result;
  }

  async #markCancelled(ref: SubagentRef, fallback: SubagentRecord): Promise<SubagentRecord> {
    const current = await this.#get(ref.sessionId, ref.agentId) ?? fallback;
    if (isTerminal(current.status)) return current;
    const cancelled: SubagentRecord = {
      ...current,
      status: "cancelled",
      finishedAt: current.finishedAt ?? nowIso(),
      error: current.error ?? "Subagent job was cancelled.",
    };
    await this.#put(cancelled);
    return cancelled;
  }

  #get(sessionId: string, agentId: string): Promise<SubagentRecord | undefined> {
    return this.#kv.get<SubagentRecord>(this.#key(sessionId, agentId)).then((entry) => entry.value ?? undefined);
  }

  #put(record: SubagentRecord): Promise<Deno.KvCommitResult> {
    return this.#kv.set(this.#key(record.sessionId, record.id), record);
  }

  #key(sessionId: string, agentId: string): Deno.KvKey {
    return ["subagents", sessionId, agentId];
  }

  #refKey(ref: SubagentRef): string {
    return `${ref.sessionId}:${ref.agentId}`;
  }
}
