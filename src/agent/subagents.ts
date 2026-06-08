import type { ChatMessageData, Tool } from "@lmstudio/sdk";

import type { AgentModelActPort } from "./model-act.ts";
import type { SkillManager } from "./skills/mod.ts";
import type { ToolContext } from "./tools/context.ts";
import { createReadOnlySubagentToolsFromDefinitions } from "./tools/registry.ts";
import {
  createDurableToolEventObserver,
  type DurableToolEventObserver,
  type EventStore,
  type LeasedWorkItem,
  type ModelActObserver,
  type WorkItem,
  type WorkQueue,
} from "../core/mod.ts";
import { errorMessage } from "../shared/error.ts";

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

/** Options for {@link SubagentRuntime}. */
export interface SubagentRuntimeOptions {
  /** Deno KV store used for durable records. */
  kv: Deno.Kv;
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
  /** Wakes the shared queue worker after new or recovered work is available. */
  wakeQueue: () => void;
  /** Deterministic clock for tests. */
  clock?: () => Date;
  /** Deterministic id factory for tests. */
  createId?: () => string;
}

/** Options for executing one leased `subagent_run` work item. */
export interface RunSubagentWorkOptions {
  /** Host/work item abort signal supplied by the shared queue processor. */
  signal: AbortSignal;
}

/** Result of reconciling durable subagent records with durable work on startup. */
export interface SubagentRecoveryResult {
  /** Pending records whose durable work is queued and ready for the shared worker. */
  requeued: string[];
  /** Pending records completed from a persisted model output. */
  completedFromModelOutput: string[];
  /** Pending records marked failed from terminal durable work. */
  failed: string[];
  /** Pending records marked cancelled from terminal durable work. */
  cancelled: string[];
  /** Pending records whose missing durable work was recreated. */
  recreatedWork: string[];
}

interface SubagentRef {
  sessionId: string;
  agentId: string;
}

interface SubagentJobStore {
  create(record: SubagentRecord): Promise<void>;
  get(sessionId: string, agentId: string): Promise<SubagentRecord | undefined>;
  list(sessionId: string): Promise<SubagentRecord[]>;
  listPending(): Promise<SubagentRecord[]>;
  update(
    ref: SubagentRef,
    update: (record: SubagentRecord) => SubagentRecord | undefined,
  ): Promise<SubagentRecord | undefined>;
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

function resetToQueued(record: SubagentRecord): SubagentRecord {
  const {
    startedAt: _startedAt,
    finishedAt: _finishedAt,
    result: _result,
    error: _error,
    ...rest
  } = record;
  return { ...rest, status: "queued" };
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

/** Deno KV-backed persistence for session-scoped subagent records. */
class DenoKvSubagentJobStore implements SubagentJobStore {
  private readonly _kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  async create(record: SubagentRecord): Promise<void> {
    const key = this._key(record.sessionId, record.id);
    const previous = await this._kv.get<SubagentRecord>(key);
    const result = await this._kv.atomic().check(previous).set(key, record).commit();
    if (!result.ok) throw new Error(`Subagent job already exists: ${record.id}`);
  }

  async get(sessionId: string, agentId: string): Promise<SubagentRecord | undefined> {
    const entry = await this._kv.get<SubagentRecord>(this._key(sessionId, agentId));
    return entry.value ?? undefined;
  }

  async list(sessionId: string): Promise<SubagentRecord[]> {
    const records: SubagentRecord[] = [];
    const iterator = this._kv.list<SubagentRecord>({ prefix: ["subagents", sessionId] });
    for await (const entry of iterator) {
      records.push(entry.value);
    }
    return records.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listPending(): Promise<SubagentRecord[]> {
    const records: SubagentRecord[] = [];
    for await (const entry of this._kv.list<SubagentRecord>({ prefix: ["subagents"] })) {
      if (entry.value.status === "queued" || entry.value.status === "running") {
        records.push(entry.value);
      }
    }
    return records.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async update(
    ref: SubagentRef,
    update: (record: SubagentRecord) => SubagentRecord | undefined,
  ): Promise<SubagentRecord | undefined> {
    const key = this._key(ref.sessionId, ref.agentId);
    while (true) {
      const entry = await this._kv.get<SubagentRecord>(key);
      if (!entry.value) return undefined;
      const next = update(entry.value);
      if (!next) return entry.value;
      const result = await this._kv.atomic().check(entry).set(key, next).commit();
      if (result.ok) return next;
    }
  }

  private _key(sessionId: string, agentId: string): Deno.KvKey {
    return ["subagents", sessionId, agentId];
  }
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

interface ActiveSubagentRun {
  controller: AbortController;
  cancellationRequested: boolean;
}

interface ModelOutputRecoveryCandidate {
  hasTerminalWorkEvent: boolean;
  text?: string;
}

function objectPayload(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return value as Record<string, unknown>;
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

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

function wasAbortedBy(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted && (error === signal.reason || isAbortError(error));
}

/** Queue-first durable subagent runtime. */
export class SubagentRuntime implements SubagentPort, AsyncDisposable {
  private readonly _store: SubagentJobStore;
  private readonly _runner: SubagentRunner;
  private readonly _events: EventStore;
  private readonly _queue: WorkQueue;
  private readonly _wakeQueue: () => void;
  private readonly _getSessionId: () => string;
  private readonly _clock: () => Date;
  private readonly _createId: () => string;
  private readonly _recoveryOwnerId = `subagent-recovery:${crypto.randomUUID()}`;

  private readonly _activeRuns = new Map<string, ActiveSubagentRun>();
  private _closed = false;

  /** Creates a session-scoped subagent runtime over durable records and shared queued work. */
  constructor(options: SubagentRuntimeOptions) {
    this._store = new DenoKvSubagentJobStore(options.kv);
    this._runner = new ReadOnlySubagentRunner({
      model: options.model,
      workspace: options.workspace,
      skills: options.skills,
    });
    this._events = options.events;
    this._queue = options.queue;
    this._wakeQueue = options.wakeQueue;
    this._getSessionId = options.getSessionId;
    this._clock = options.clock ?? (() => new Date());
    this._createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** Creates a durable queued subagent record and wakes the shared queue worker. */
  async spawn(spec: SubagentSpawnSpec): Promise<SubagentRecord> {
    if (this._closed) throw new Error("Subagent runtime is shutting down.");

    const task = spec.task.trim();
    const sessionId = this._getSessionId();
    const record: SubagentRecord = {
      id: this._createId(),
      sessionId,
      title: spec.title?.trim() || defaultTitle(task),
      task,
      status: "queued",
      createdAt: this._nowIso(),
    };

    await this._store.create(record);
    await this._queue.submit({
      id: record.id,
      kind: "subagent_run",
      sessionId,
      payload: { task, title: record.title },
    });
    this._wakeQueue();
    return record;
  }

  /** Returns a subagent in the current session by id. */
  status(agentId: string): Promise<SubagentRecord | undefined> {
    return this._getCurrentSessionRecord(agentId);
  }

  /** Lists subagents in the current session ordered by creation time. */
  list(): Promise<SubagentRecord[]> {
    return this._store.list(this._getSessionId());
  }

  /** Returns a subagent record, including terminal result or error when present. */
  result(agentId: string): Promise<SubagentRecord | undefined> {
    return this._getCurrentSessionRecord(agentId);
  }

  /** Cancels a queued or running job; terminal jobs are returned unchanged. */
  async cancel(agentId: string): Promise<SubagentRecord | undefined> {
    const sessionId = this._getSessionId();
    const record = await this._store.get(sessionId, agentId);
    if (!record) return undefined;
    if (isTerminal(record.status)) return record;

    const ref = { sessionId, agentId };
    const active = this._activeRuns.get(this._refKey(ref));
    if (active) {
      active.cancellationRequested = true;
      active.controller.abort(abortError("Subagent job was cancelled."));
    }

    const cancelled = await this._markCancelled(ref, record);
    await this._queue.cancel(record.id, { reason: "Subagent job was cancelled." });
    return cancelled;
  }

  /** Reconciles pending records with durable `subagent_run` work after global startup recovery. */
  async recoverPendingOnStartup(): Promise<SubagentRecoveryResult> {
    const result: SubagentRecoveryResult = {
      requeued: [],
      completedFromModelOutput: [],
      failed: [],
      cancelled: [],
      recreatedWork: [],
    };

    for (const record of await this._store.listPending()) {
      const work = await this._queue.get(record.id);
      if (!work) {
        await this._queue.submit({
          id: record.id,
          kind: "subagent_run",
          sessionId: record.sessionId,
          payload: { task: record.task, title: record.title },
        });
        await this._resetRecordToQueued(record);
        result.recreatedWork.push(record.id);
        continue;
      }

      if (work.kind !== "subagent_run" || work.sessionId !== record.sessionId) {
        await this._markFailed(
          { sessionId: record.sessionId, agentId: record.id },
          `Subagent durable work mismatch for ${record.id}.`,
        );
        result.failed.push(record.id);
        continue;
      }

      const recovered = await this._completeFromPersistedModelOutput(record, work);
      if (recovered) {
        result.completedFromModelOutput.push(record.id);
        continue;
      }

      if (work.status === "queued") {
        await this._resetRecordToQueued(record);
        result.requeued.push(record.id);
        continue;
      }

      if (work.status === "failed") {
        await this._markFailed(
          { sessionId: record.sessionId, agentId: record.id },
          work.failure ?? "Subagent durable work failed.",
        );
        result.failed.push(record.id);
        continue;
      }

      if (work.status === "cancelled") {
        await this._markCancelled(
          { sessionId: record.sessionId, agentId: record.id },
          record,
          work.failure ?? "Subagent durable work was cancelled.",
        );
        result.cancelled.push(record.id);
      }
    }

    if (result.requeued.length > 0 || result.recreatedWork.length > 0) {
      this._wakeQueue();
    }
    return result;
  }

  /** Runs one leased `subagent_run` work item and settles its durable queue state. */
  async runQueuedWork(work: LeasedWorkItem, options: RunSubagentWorkOptions): Promise<void> {
    if (work.kind !== "subagent_run") {
      throw new Error(`Unsupported subagent work kind: ${work.kind}`);
    }

    const ref = { sessionId: work.sessionId, agentId: work.id };
    const record = await this._store.get(ref.sessionId, ref.agentId);
    if (!record) {
      const reason = `Subagent record not found for leased work: ${work.id}`;
      await this._queue.fail(work.id, { leaseId: work.lease.id, reason });
      throw new Error(reason);
    }

    if (isTerminal(record.status)) {
      await this._settleLeasedWorkFromTerminalRecord(work, record);
      return;
    }

    const running = await this._store.update(ref, (current) => {
      if (isTerminal(current.status)) return undefined;
      if (current.status !== "queued" && current.status !== "running") return undefined;
      return {
        ...current,
        status: "running",
        startedAt: current.startedAt ?? this._nowIso(),
      };
    });
    if (!running || isTerminal(running.status)) {
      const latest = await this._store.get(ref.sessionId, ref.agentId);
      if (latest && isTerminal(latest.status)) await this._settleLeasedWorkFromTerminalRecord(work, latest);
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
        task: running.task,
        signal,
        observer: durableObserver,
      });
      await durableObserver.flush();

      if (options.signal.aborted) throw options.signal.reason ?? abortError("Subagent work was aborted.");
      if (active.cancellationRequested || active.controller.signal.aborted) {
        await this._markCancelled(ref, running);
        await this._queue.cancel(work.id, { reason: "Subagent job was cancelled." });
        return;
      }

      await this._appendModelMessage(ref, work, output.text);
      const completed = await this._store.update(ref, (latest) => {
        if (latest.status !== "running") return undefined;
        return {
          ...latest,
          status: "completed",
          finishedAt: this._nowIso(),
          result: output.text,
        };
      });
      if (completed?.status === "completed") {
        await this._queue.complete(work.id, { leaseId: work.lease.id });
      }
    } catch (error) {
      await durableObserver.flush();
      if (wasAbortedBy(options.signal, error)) {
        throw error;
      }
      if (active.cancellationRequested && wasAbortedBy(active.controller.signal, error)) {
        await this._markCancelled(ref, running);
        await this._queue.cancel(work.id, { reason: "Subagent job was cancelled." });
        return;
      }
      if (isAbortError(error) && active.controller.signal.aborted && !active.cancellationRequested) {
        throw error;
      }

      const message = errorMessage(error);
      const failed = await this._markFailed(ref, message);
      if (failed?.status === "failed") {
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

  private async _completeFromPersistedModelOutput(record: SubagentRecord, work: WorkItem): Promise<boolean> {
    const candidate = await this._modelOutputRecoveryCandidate(work.id);
    if (candidate.hasTerminalWorkEvent || candidate.text === undefined) return false;

    if (work.status === "completed") {
      await this._markCompletedFromOutput(record, candidate.text);
      return true;
    }

    if (work.status !== "queued") return false;

    const leased = await this._queue.lease(work.id, {
      ownerId: this._recoveryOwnerId,
      kinds: ["subagent_run"],
      now: this._clock(),
    });
    if (!leased) return false;

    const completed = await this._markCompletedFromOutput(record, candidate.text);
    if (completed?.status === "completed") {
      await this._queue.complete(leased.id, {
        leaseId: leased.lease.id,
        now: this._clock(),
      });
      return true;
    }

    await this._queue.release(leased.id, {
      leaseId: leased.lease.id,
      now: this._clock(),
    });
    return false;
  }

  private async _modelOutputRecoveryCandidate(workId: string): Promise<ModelOutputRecoveryCandidate> {
    const candidate: ModelOutputRecoveryCandidate = { hasTerminalWorkEvent: false };
    for (const event of await this._events.listByWork(workId)) {
      if (isTerminalWorkEvent(event.category)) {
        candidate.hasTerminalWorkEvent = true;
        continue;
      }
      if (event.category === "model.message") {
        const text = textFromModelMessagePayload(event.payload);
        if (text !== undefined) candidate.text = text;
      }
    }
    return candidate;
  }

  private async _resetRecordToQueued(record: SubagentRecord): Promise<SubagentRecord | undefined> {
    return await this._store.update({ sessionId: record.sessionId, agentId: record.id }, (current) => {
      if (isTerminal(current.status)) return undefined;
      return resetToQueued(current);
    });
  }

  private async _markCompletedFromOutput(
    record: SubagentRecord,
    text: string,
  ): Promise<SubagentRecord | undefined> {
    return await this._store.update({ sessionId: record.sessionId, agentId: record.id }, (current) => {
      if (isTerminal(current.status)) return undefined;
      return {
        ...current,
        status: "completed",
        finishedAt: current.finishedAt ?? this._nowIso(),
        result: text,
      };
    });
  }

  private async _markFailed(ref: SubagentRef, reason: string): Promise<SubagentRecord | undefined> {
    return await this._store.update(ref, (current) => {
      if (isTerminal(current.status)) return undefined;
      return {
        ...current,
        status: "failed",
        finishedAt: current.finishedAt ?? this._nowIso(),
        error: reason,
      };
    });
  }

  private async _markCancelled(
    ref: SubagentRef,
    fallback: SubagentRecord,
    reason = "Subagent job was cancelled.",
  ): Promise<SubagentRecord> {
    return await this._store.update(ref, (current) => {
      if (isTerminal(current.status)) return undefined;
      return {
        ...current,
        status: "cancelled",
        finishedAt: current.finishedAt ?? this._nowIso(),
        error: current.error ?? reason,
      };
    }) ?? fallback;
  }

  private async _settleLeasedWorkFromTerminalRecord(work: LeasedWorkItem, record: SubagentRecord): Promise<void> {
    if (record.status === "completed") {
      await this._queue.complete(work.id, { leaseId: work.lease.id });
      return;
    }
    if (record.status === "failed") {
      await this._queue.fail(work.id, {
        leaseId: work.lease.id,
        reason: record.error ?? "Subagent job failed.",
      });
      return;
    }
    await this._queue.cancel(work.id, {
      reason: record.error ?? "Subagent job was cancelled.",
    });
  }

  private _getCurrentSessionRecord(agentId: string): Promise<SubagentRecord | undefined> {
    return this._store.get(this._getSessionId(), agentId);
  }

  private _refKey(ref: SubagentRef): string {
    return `${ref.sessionId}:${ref.agentId}`;
  }

  private _nowIso(): string {
    return this._clock().toISOString();
  }
}
