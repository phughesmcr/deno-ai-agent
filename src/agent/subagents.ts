import type { ChatMessageData, Tool } from "@lmstudio/sdk";

import {
  createDurableToolEventObserver,
  type DurableToolEventObserver,
  type EventStore,
  type LeasedWorkItem,
  type ModelActObserver,
  type WorkItem,
  type WorkQueue,
} from "../core/mod.ts";
import { isAbortError } from "../shared/abort.ts";
import { errorMessage } from "../shared/error.ts";
import { objectPayload } from "../shared/record.ts";
import type { AgentModelActPort } from "./model-act.ts";
import type { SkillManager } from "./skills/mod.ts";
import type { ToolContext } from "./tools/context.ts";
import { createReadOnlySubagentToolsFromDefinitions } from "./tools/registry.ts";

/** Subagent lifecycle state projected from durable work. */
export type SubagentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** Session-scoped subagent job projection. */
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

/** Options for {@link SubagentRuntime}. */
export interface SubagentRuntimeOptions {
  /** Durable event store for subagent model/tool activity. */
  events: EventStore;
  /** Durable work queue for `subagent_run` lifecycle events. */
  queue: WorkQueue;
  /** Model-act adapter capable of running read-only subagents. */
  model: Pick<AgentModelActPort, "runSubagent">;
  /** Workspace used by read-only child tools. */
  workspace: ToolContext;
  /** Skill catalog shared with the parent process. */
  skills: SkillManager;
  /** Returns the current parent session id. */
  getSessionId: () => string;
  /** Wakes the shared queue worker after new work is available. */
  wakeQueue: () => void;
  /** Deterministic id factory for tests. */
  createId?: () => string;
}

/** Options for executing one leased `subagent_run` work item. */
export interface RunSubagentWorkOptions {
  /** Host/work item abort signal supplied by the shared queue processor. */
  signal: AbortSignal;
}

interface SubagentRef {
  sessionId: string;
  agentId: string;
}

interface SubagentRunner {
  run(request: {
    sessionId: string;
    agentId: string;
    task: string;
    signal: AbortSignal;
    observer?: ModelActObserver;
  }): Promise<{ text: string }>;
}

interface ActiveSubagentRun {
  controller: AbortController;
  cancellationRequested: boolean;
}

interface SubagentRunPayload {
  task: string;
  title: string;
}

const SUBAGENT_SYSTEM_PROMPT = [
  "You are a read-only research subagent for a parent coding agent.",
  "Inspect the workspace and report concise findings for the requested task.",
  "You may use only read, grep, find, ls, and skill.",
  "Do not modify files, run shell commands, ask the user questions, manage todos, or spawn other agents.",
  "Return a final answer with relevant file paths and line references where useful.",
].join("\n");

function defaultTitle(task: string): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 80) || "Subagent task";
}

function isTerminal(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function subagentResultMessage(text: string): ChatMessageData {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as ChatMessageData;
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error("Subagent job service is not configured for this process."));
}

function subagentRunPayload(value: unknown): SubagentRunPayload {
  const record = objectPayload(value);
  const task = record?.["task"];
  const title = record?.["title"];
  if (typeof task !== "string" || typeof title !== "string") {
    throw new Error("Invalid subagent_run work payload");
  }
  return { task, title };
}

function textFromModelMessagePayload(payload: unknown): string | undefined {
  const message = objectPayload(objectPayload(payload)?.["message"]);
  const content = message?.["content"];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part) => {
      const partRecord = objectPayload(part);
      return partRecord?.["type"] === "text" && typeof partRecord["text"] === "string" ? [partRecord["text"]] : [];
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

function isTerminalWorkEvent(category: string): boolean {
  return category === "work.completed" || category === "work.failed" || category === "work.cancelled";
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function wasAbortedBy(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && (error === signal.reason || isAbortError(error));
}

function statusFromWork(work: WorkItem): SubagentStatus {
  if (work.status === "leased") return "running";
  return work.status;
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

/** Runs one read-only subagent model act with the restricted child tool set. */
class ReadOnlySubagentRunner implements SubagentRunner {
  private readonly _model: Pick<AgentModelActPort, "runSubagent">;
  private readonly _workspace: ToolContext;
  private readonly _skills: SkillManager;

  constructor(options: {
    model: Pick<AgentModelActPort, "runSubagent">;
    workspace: ToolContext;
    skills: SkillManager;
  }) {
    this._model = options.model;
    this._workspace = options.workspace;
    this._skills = options.skills;
  }

  async run(request: {
    sessionId: string;
    agentId: string;
    task: string;
    signal: AbortSignal;
    observer?: ModelActObserver;
  }): Promise<{ text: string }> {
    await this._skills.refresh();
    return await this._model.runSubagent({
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      task: request.task,
      tools: createReadOnlySubagentTools(this._workspace, this._skills),
      signal: request.signal,
      observer: request.observer,
    });
  }
}

/** Queue-first durable subagent runtime. */
export class SubagentRuntime implements SubagentPort, AsyncDisposable {
  private readonly _runner: SubagentRunner;
  private readonly _events: EventStore;
  private readonly _queue: WorkQueue;
  private readonly _wakeQueue: () => void;
  private readonly _getSessionId: () => string;
  private readonly _createId: () => string;
  private readonly _activeRuns = new Map<string, ActiveSubagentRun>();
  private _closed = false;

  /** Creates a session-scoped subagent runtime over shared queued work. */
  constructor(options: SubagentRuntimeOptions) {
    this._runner = new ReadOnlySubagentRunner({
      model: options.model,
      workspace: options.workspace,
      skills: options.skills,
    });
    this._events = options.events;
    this._queue = options.queue;
    this._wakeQueue = options.wakeQueue;
    this._getSessionId = options.getSessionId;
    this._createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** Creates durable queued subagent work and wakes the shared queue worker. */
  async spawn(spec: SubagentSpawnSpec): Promise<SubagentRecord> {
    if (this._closed) throw new Error("Subagent runtime is shutting down.");

    const task = spec.task.trim();
    const sessionId = this._getSessionId();
    const title = spec.title?.trim() || defaultTitle(task);
    const work = await this._queue.submit({
      id: this._createId(),
      kind: "subagent_run",
      sessionId,
      payload: { task, title },
    });
    this._wakeQueue();
    return await this._projectWorkOrThrow(work);
  }

  /** Returns a subagent in the current session by id. */
  async status(agentId: string): Promise<SubagentRecord | undefined> {
    return await this._getCurrentSessionRecord(agentId);
  }

  /** Lists subagents in the current session ordered by creation time. */
  async list(): Promise<SubagentRecord[]> {
    const records: SubagentRecord[] = [];
    const works = await this._queue.listWork({ kind: "subagent_run", sessionId: this._getSessionId() });
    for (const work of works) {
      const record = await this._projectWork(work);
      if (record) records.push(record);
    }
    return records;
  }

  /** Returns a subagent record, including terminal result or error when present. */
  async result(agentId: string): Promise<SubagentRecord | undefined> {
    return await this._getCurrentSessionRecord(agentId);
  }

  /** Cancels a queued or running job; terminal jobs are returned unchanged. */
  async cancel(agentId: string): Promise<SubagentRecord | undefined> {
    const record = await this._getCurrentSessionRecord(agentId);
    if (!record || isTerminal(record.status)) return record;

    const ref = { sessionId: record.sessionId, agentId };
    const active = this._activeRuns.get(this._refKey(ref));
    if (active) {
      active.cancellationRequested = true;
      active.controller.abort(abortError("Subagent job was cancelled."));
    }

    await this._queue.cancel(record.id, { reason: "Subagent job was cancelled." });
    return await this._getCurrentSessionRecord(agentId);
  }

  /** Runs one leased `subagent_run` work item and settles its durable queue state. */
  async runQueuedWork(work: LeasedWorkItem, options: RunSubagentWorkOptions): Promise<void> {
    if (work.kind !== "subagent_run") {
      throw new Error(`Unsupported subagent work kind: ${work.kind}`);
    }

    const payload = subagentRunPayload(work.payload);
    const ref = { sessionId: work.sessionId, agentId: work.id };
    const persistedResult = await this._persistedResultWithoutTerminal(work.id);
    if (persistedResult !== undefined) {
      if (await this._isStillLeased(work)) await this._queue.complete(work.id, { leaseId: work.lease.id });
      return;
    }

    const active: ActiveSubagentRun = {
      controller: new AbortController(),
      cancellationRequested: false,
    };
    this._activeRuns.set(this._refKey(ref), active);
    const signal = AbortSignal.any([options.signal, active.controller.signal]);
    const durableObserver = this._createDurableObserver(ref, work);

    try {
      durableObserver.ensureRoundStarted(0);
      const output = await this._runner.run({
        sessionId: ref.sessionId,
        agentId: ref.agentId,
        task: payload.task,
        signal,
        observer: durableObserver,
      });
      await durableObserver.flush();

      if (options.signal.aborted) throw options.signal.reason ?? abortError("Subagent work was aborted.");
      if (await this._wasCancelledOrReleased(work, active)) return;

      await this._appendModelMessage(ref, work, output.text);
      if (await this._isStillLeased(work)) {
        await this._queue.complete(work.id, { leaseId: work.lease.id });
      }
    } catch (error) {
      await durableObserver.flush();
      if (wasAbortedBy(options.signal, error)) throw error;
      if (active.cancellationRequested && wasAbortedBy(active.controller.signal, error)) return;
      if (isAbortError(error) && active.controller.signal.aborted && !active.cancellationRequested) throw error;

      const message = errorMessage(error);
      if (await this._isStillLeased(work)) {
        await this._queue.fail(work.id, { leaseId: work.lease.id, reason: message });
      }
      throw error;
    } finally {
      this._activeRuns.delete(this._refKey(ref));
    }
  }

  /** Aborts active model calls without durably cancelling their work. */
  async shutdown(): Promise<void> {
    await this[Symbol.asyncDispose]();
  }

  /** Aborts active model calls without durably cancelling their work. */
  [Symbol.asyncDispose](): Promise<void> {
    this._closed = true;
    for (const active of this._activeRuns.values()) {
      if (!active.controller.signal.aborted) {
        active.controller.abort(abortError("Subagent runtime is shutting down."));
      }
    }
    return Promise.resolve();
  }

  private _createDurableObserver(ref: SubagentRef, work: LeasedWorkItem): DurableToolEventObserver {
    return createDurableToolEventObserver({
      events: this._events,
      sessionId: ref.sessionId,
      workId: work.id,
    });
  }

  private async _appendModelMessage(ref: SubagentRef, work: LeasedWorkItem, text: string): Promise<void> {
    await this._events.append({
      category: "model.message",
      workId: work.id,
      sessionId: ref.sessionId,
      payload: { message: subagentResultMessage(text) },
    });
  }

  private async _projectWork(work: WorkItem): Promise<SubagentRecord | undefined> {
    if (work.kind !== "subagent_run") return undefined;
    const payload = subagentRunPayload(work.payload);
    const events = await this._events.listByWork(work.id);
    const startedAt = events.find((event) => event.category === "work.leased")?.createdAt;
    const terminal = events.find((event) => isTerminalWorkEvent(event.category));
    const result = events
      .filter((event) => event.category === "model.message")
      .map((event) => textFromModelMessagePayload(event.payload))
      .filter((text) => text !== undefined)
      .at(-1);
    const status = statusFromWork(work);
    return {
      id: work.id,
      sessionId: work.sessionId,
      title: payload.title,
      task: payload.task,
      status,
      createdAt: work.createdAt,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(terminal !== undefined ? { finishedAt: terminal.createdAt } : {}),
      ...(status === "completed" && result !== undefined ? { result } : {}),
      ...((status === "failed" || status === "cancelled") && work.failure !== undefined ? { error: work.failure } : {}),
    };
  }

  private async _persistedResultWithoutTerminal(workId: string): Promise<string | undefined> {
    let result: string | undefined;
    for (const event of await this._events.listByWork(workId)) {
      if (isTerminalWorkEvent(event.category)) return undefined;
      if (event.category === "model.message") {
        const text = textFromModelMessagePayload(event.payload);
        if (text !== undefined) result = text;
      }
    }
    return result;
  }

  private async _projectWorkOrThrow(work: WorkItem): Promise<SubagentRecord> {
    const record = await this._projectWork(work);
    if (!record) throw new Error(`Subagent work could not be projected: ${work.id}`);
    return record;
  }

  private async _getCurrentSessionRecord(agentId: string): Promise<SubagentRecord | undefined> {
    const work = await this._queue.get(agentId);
    if (!work || work.kind !== "subagent_run" || work.sessionId !== this._getSessionId()) return undefined;
    return await this._projectWork(work);
  }

  private async _isStillLeased(work: LeasedWorkItem): Promise<boolean> {
    const current = await this._queue.get(work.id);
    return current?.status === "leased" && current.lease?.id === work.lease.id;
  }

  private async _wasCancelledOrReleased(work: LeasedWorkItem, active: ActiveSubagentRun): Promise<boolean> {
    if (active.cancellationRequested || active.controller.signal.aborted) return true;
    return !await this._isStillLeased(work);
  }

  private _refKey(ref: SubagentRef): string {
    return `${ref.sessionId}:${ref.agentId}`;
  }
}
