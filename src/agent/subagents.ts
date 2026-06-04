import type { Tool } from "@lmstudio/sdk";

import type { AgentModelActPort } from "./model-act.ts";
import type { SkillManager } from "./skills/mod.ts";
import type { ToolContext } from "./tools/context.ts";
import { createReadOnlySubagentToolsFromDefinitions } from "./tools/registry.ts";

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

/** Options for {@link SubagentManager}. */
export interface SubagentManagerOptions {
  /** Deno KV store used for process-local records. */
  kv: Deno.Kv;
  /** Model-act adapter capable of running read-only subagents. */
  model: Pick<AgentModelActPort, "runSubagent">;
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
  return createReadOnlySubagentToolsFromDefinitions(workspace, skills);
}

/**
 * Async, process-local subagent job manager backed by session-scoped Deno KV records.
 * Active controllers and queue state are intentionally in memory only.
 */
export class SubagentManager implements SubagentPort {
  private readonly _kv: Deno.Kv;
  private readonly _model: Pick<AgentModelActPort, "runSubagent">;
  private readonly _workspace: ToolContext;
  private readonly _skills: SkillManager;
  private readonly _getSessionId: () => string;

  private _queue: SubagentRef[] = [];
  private _activeControllers = new Map<string, AbortController>();
  private _running = false;
  private _currentRun: Promise<void> | undefined;
  private _closed = false;

  /** Creates a session-scoped subagent manager over a Deno KV store. */
  constructor(options: SubagentManagerOptions) {
    this._kv = options.kv;
    this._model = options.model;
    this._workspace = options.workspace;
    this._skills = options.skills;
    this._getSessionId = options.getSessionId;
  }

  /** Creates a queued subagent job and schedules it for async execution. */
  async spawn(spec: SubagentSpawnSpec): Promise<SubagentRecord> {
    if (this._closed) throw new Error("Subagent manager is shutting down.");

    const task = spec.task.trim();
    const sessionId = this._getSessionId();
    const record: SubagentRecord = {
      id: crypto.randomUUID(),
      sessionId,
      title: spec.title?.trim() || defaultTitle(task),
      task,
      status: "queued",
      createdAt: nowIso(),
    };

    await this._put(record);
    this._queue.push({ sessionId, agentId: record.id });
    this._scheduleNext();
    return record;
  }

  /** Returns a subagent in the current session by id. */
  status(agentId: string): Promise<SubagentRecord | undefined> {
    return this._get(this._getSessionId(), agentId);
  }

  /** Lists subagents in the current session ordered by creation time. */
  async list(): Promise<SubagentRecord[]> {
    const sessionId = this._getSessionId();
    const records: SubagentRecord[] = [];
    const iterator = this._kv.list<SubagentRecord>({ prefix: ["subagents", sessionId] });
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
    const sessionId = this._getSessionId();
    const record = await this._get(sessionId, agentId);
    if (!record) return undefined;
    if (isTerminal(record.status)) return record;

    const ref = { sessionId, agentId };
    if (record.status === "queued") {
      this._queue = this._queue.filter((item) => this._refKey(item) !== this._refKey(ref));
    }

    this._activeControllers.get(this._refKey(ref))?.abort();
    return await this._markCancelled(ref, record);
  }

  /** Aborts active work and prevents queued work from starting. */
  async shutdown(): Promise<void> {
    this._closed = true;
    const queued = this._queue;
    this._queue = [];

    for (const controller of this._activeControllers.values()) {
      controller.abort();
    }

    await Promise.all(queued.map(async (ref) => {
      const record = await this._get(ref.sessionId, ref.agentId);
      if (record && record.status === "queued") {
        await this._markCancelled(ref, record);
      }
    }));

    await this._currentRun?.catch(() => {});
  }

  private _scheduleNext(): void {
    if (this._closed || this._running) return;
    const next = this._queue.shift();
    if (!next) return;

    this._running = true;
    const run = this._runQueuedJob(next)
      .catch(() => {})
      .finally(() => {
        this._running = false;
        this._currentRun = undefined;
        this._scheduleNext();
      });
    this._currentRun = run;
  }

  private async _runQueuedJob(ref: SubagentRef): Promise<void> {
    const record = await this._get(ref.sessionId, ref.agentId);
    if (!record || record.status !== "queued") return;

    const runningRecord: SubagentRecord = {
      ...record,
      status: "running",
      startedAt: nowIso(),
    };
    await this._put(runningRecord);

    const controller = new AbortController();
    this._activeControllers.set(this._refKey(ref), controller);

    try {
      const result = await this._runModel(record.task, controller.signal);
      const latest = await this._get(ref.sessionId, ref.agentId) ?? runningRecord;
      if (latest.status === "cancelled" || controller.signal.aborted) {
        await this._markCancelled(ref, latest);
        return;
      }
      await this._put({
        ...latest,
        status: "completed",
        finishedAt: nowIso(),
        result,
      });
    } catch (error) {
      const latest = await this._get(ref.sessionId, ref.agentId) ?? runningRecord;
      if (latest.status === "cancelled" || isAbortError(error, controller.signal)) {
        await this._markCancelled(ref, latest);
        return;
      }
      await this._put({
        ...latest,
        status: "failed",
        finishedAt: nowIso(),
        error: errorMessage(error),
      });
    } finally {
      this._activeControllers.delete(this._refKey(ref));
    }
  }

  private async _runModel(task: string, signal: AbortSignal): Promise<string> {
    await this._skills.refresh();
    const result = await this._model.runSubagent({
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      task,
      tools: createReadOnlySubagentTools(this._workspace, this._skills),
      signal,
    });
    return result.text;
  }

  private async _markCancelled(ref: SubagentRef, fallback: SubagentRecord): Promise<SubagentRecord> {
    const current = await this._get(ref.sessionId, ref.agentId) ?? fallback;
    if (isTerminal(current.status)) return current;
    const cancelled: SubagentRecord = {
      ...current,
      status: "cancelled",
      finishedAt: current.finishedAt ?? nowIso(),
      error: current.error ?? "Subagent job was cancelled.",
    };
    await this._put(cancelled);
    return cancelled;
  }

  private _get(sessionId: string, agentId: string): Promise<SubagentRecord | undefined> {
    return this._kv.get<SubagentRecord>(this._key(sessionId, agentId)).then((entry) => entry.value ?? undefined);
  }

  private _put(record: SubagentRecord): Promise<Deno.KvCommitResult> {
    return this._kv.set(this._key(record.sessionId, record.id), record);
  }

  private _key(sessionId: string, agentId: string): Deno.KvKey {
    return ["subagents", sessionId, agentId];
  }

  private _refKey(ref: SubagentRef): string {
    return `${ref.sessionId}:${ref.agentId}`;
  }
}
