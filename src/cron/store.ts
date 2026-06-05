import type { TelegramConversationRef } from "../telegram/conversation.ts";
import { telegramThreadKey } from "../telegram/conversation.ts";
import type { CronPermissionBrokerRule, CronPermissionProfile, CronPermissionToolRule } from "./permissions.ts";
import type { CronSchedule } from "./schedule.ts";

/** Controls whether a cron job gets a clean or retained chat session on each run. */
export type CronSessionMode = "fresh" | "persistent";

/** Durable user-created cron job. */
export interface CronJob extends TelegramConversationRef {
  /** Stable job id. */
  id: string;
  /** Prompt sent to the agent on each scheduled run. */
  prompt: string;
  /** Deterministic schedule data extracted from user-facing text. */
  schedule: CronSchedule;
  /** ISO timestamp for the next due run. */
  nextRunAt: string;
  /** Whether dispatcher should execute this job. */
  enabled: boolean;
  /** Whether each run uses a fresh or retained chat session. */
  sessionMode: CronSessionMode;
  /** Explicit background permissions for this job. */
  permissionProfile: CronPermissionProfile;
  /** ISO timestamp for job creation. */
  createdAt: string;
  /** ISO timestamp for last job update. */
  updatedAt: string;
  /** ISO timestamp for last successful run. */
  lastRunAt?: string;
  /** ISO timestamp for last failed run. */
  lastFailedAt?: string;
  /** Last failure message. */
  lastError?: string;
  /** Telegram topic name when a cron topic is created or known. */
  topicName?: string;
}

/** Input for creating a cron job. */
export interface CreateCronJobInput extends TelegramConversationRef {
  prompt: string;
  schedule: CronSchedule;
  nextRunAt: string;
  sessionMode?: CronSessionMode;
  permissionProfile: CronPermissionProfile;
  topicName?: string;
}

function jobKey(id: string): Deno.KvKey {
  return ["cron", "job", id];
}

function chatKey(chatId: number, id: string): Deno.KvKey {
  return ["cron", "chat", chatId, id];
}

function chatPrefix(chatId: number): Deno.KvKey {
  return ["cron", "chat", chatId];
}

function dueKey(nextRunAt: string, id: string): Deno.KvKey {
  return ["cron", "due", nextRunAt, id];
}

function duePrefix(): Deno.KvKey {
  return ["cron", "due"];
}

function leaseKey(id: string): Deno.KvKey {
  return ["cron", "lease", id];
}

function nowIso(): string {
  return new Date().toISOString();
}

function createJob(input: CreateCronJobInput): CronJob {
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    chatId: input.chatId,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    prompt: input.prompt,
    schedule: input.schedule,
    nextRunAt: input.nextRunAt,
    enabled: true,
    sessionMode: input.sessionMode ?? "fresh",
    permissionProfile: input.permissionProfile,
    createdAt: now,
    updatedAt: now,
    ...(input.topicName !== undefined ? { topicName: input.topicName } : {}),
  };
}

function sortJobs(a: CronJob, b: CronJob): number {
  const byTime = a.nextRunAt.localeCompare(b.nextRunAt);
  if (byTime !== 0) return byTime;
  return a.id.localeCompare(b.id);
}

function includesToolRule(rules: CronPermissionToolRule[], candidate: CronPermissionToolRule): boolean {
  return rules.some((rule) => rule.operation === candidate.operation && rule.target === candidate.target);
}

function includesBrokerRule(rules: CronPermissionBrokerRule[], candidate: CronPermissionBrokerRule): boolean {
  return rules.some((rule) => rule.permission === candidate.permission && rule.value === candidate.value);
}

function mergePermissionProfile(
  profile: CronPermissionProfile,
  patch: {
    toolRules?: CronPermissionToolRule[];
    brokerRules?: CronPermissionBrokerRule[];
  },
): CronPermissionProfile {
  const toolRules = [...profile.toolRules];
  for (const rule of patch.toolRules ?? []) {
    if (!includesToolRule(toolRules, rule)) toolRules.push(rule);
  }

  const brokerRules = [...profile.brokerRules];
  for (const rule of patch.brokerRules ?? []) {
    if (!includesBrokerRule(brokerRules, rule)) brokerRules.push(rule);
  }

  return { ...profile, toolRules, brokerRules };
}

/** Deno KV store for durable cron jobs and due indexes. */
export class CronJobStore {
  private readonly _kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this._kv = kv;
  }

  /** Creates an enabled cron job and due index entry. */
  async create(input: CreateCronJobInput): Promise<CronJob> {
    const job = createJob(input);
    const result = await this._kv.atomic()
      .check({ key: jobKey(job.id), versionstamp: null })
      .set(jobKey(job.id), job)
      .set(chatKey(job.chatId, job.id), job.id)
      .set(dueKey(job.nextRunAt, job.id), job.id)
      .commit();
    if (!result.ok) throw new Error("Cron job was not created");
    return job;
  }

  /** Returns one job by id. */
  async get(id: string): Promise<CronJob | undefined> {
    const entry = await this._kv.get<CronJob>(jobKey(id));
    return entry.value ? normalizeJob(entry.value) : undefined;
  }

  /** Lists enabled and disabled cron jobs for one Telegram chat. */
  async listForChat(chatId: number): Promise<CronJob[]> {
    const jobs: CronJob[] = [];
    for await (const entry of this._kv.list<string>({ prefix: chatPrefix(chatId) })) {
      const job = await this.get(entry.value);
      if (job) jobs.push(job);
    }
    return jobs.toSorted(sortJobs);
  }

  /** Lists enabled jobs due at or before `now`. */
  async listDue(now: string): Promise<CronJob[]> {
    const jobs: CronJob[] = [];
    for await (const entry of this._kv.list<string>({ prefix: duePrefix() })) {
      const nextRunAt = entry.key[2];
      if (typeof nextRunAt !== "string" || nextRunAt > now) break;
      const job = await this.get(entry.value);
      if (job?.enabled) jobs.push(job);
    }
    return jobs.toSorted(sortJobs);
  }

  /** Deletes a cron job and its indexes. */
  async delete(id: string): Promise<CronJob | undefined> {
    const entry = await this._kv.get<CronJob>(jobKey(id));
    const job = entry.value ? normalizeJob(entry.value) : undefined;
    if (!job) return undefined;
    await this._kv.atomic()
      .check(entry)
      .delete(jobKey(id))
      .delete(chatKey(job.chatId, id))
      .delete(dueKey(job.nextRunAt, id))
      .delete(leaseKey(id))
      .commit();
    return job;
  }

  /** Acquires a short lease for a due job. */
  async acquireLease(id: string, leasedAt: string, leaseMs: number): Promise<CronJob | undefined> {
    const [jobEntry, leaseEntry] = await this._kv.getMany<[CronJob, { leasedAt: string }]>([
      jobKey(id),
      leaseKey(id),
    ]);
    const job = jobEntry.value ? normalizeJob(jobEntry.value) : undefined;
    if (!job?.enabled || leaseEntry.value) return undefined;

    const result = await this._kv.atomic()
      .check(jobEntry)
      .check(leaseEntry)
      .set(leaseKey(id), { leasedAt }, { expireIn: leaseMs })
      .commit();
    return result.ok ? job : undefined;
  }

  /** Updates whether a cron job uses fresh or persistent sessions. */
  async setSessionMode(id: string, sessionMode: CronSessionMode): Promise<CronJob | undefined> {
    const entry = await this._kv.get<CronJob>(jobKey(id));
    const job = entry.value ? normalizeJob(entry.value) : undefined;
    if (!job) return undefined;
    const updated: CronJob = { ...job, sessionMode, updatedAt: nowIso() };
    const result = await this._kv.atomic()
      .check(entry)
      .set(jobKey(id), updated)
      .commit();
    return result.ok ? updated : undefined;
  }

  /** Adds exact preapproved permission rules to a cron job without duplicating existing rules. */
  async addPermissionRules(
    id: string,
    patch: {
      toolRules?: CronPermissionToolRule[];
      brokerRules?: CronPermissionBrokerRule[];
    },
  ): Promise<CronJob | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const entry = await this._kv.get<CronJob>(jobKey(id));
      const job = entry.value ? normalizeJob(entry.value) : undefined;
      if (!job) return undefined;
      const permissionProfile = mergePermissionProfile(job.permissionProfile, patch);
      if (
        permissionProfile.toolRules.length === job.permissionProfile.toolRules.length &&
        permissionProfile.brokerRules.length === job.permissionProfile.brokerRules.length
      ) {
        return job;
      }
      const updated: CronJob = { ...job, permissionProfile, updatedAt: nowIso() };
      const result = await this._kv.atomic()
        .check(entry)
        .set(jobKey(id), updated)
        .commit();
      if (result.ok) return updated;
    }
    throw new Error(`Cron job ${id} permission profile was not updated`);
  }

  /** Marks a run successful and moves the due index to the next run. */
  async completeRun(id: string, result: { ranAt: string; nextRunAt: string }): Promise<CronJob | undefined> {
    const entry = await this._kv.get<CronJob>(jobKey(id));
    const job = entry.value ? normalizeJob(entry.value) : undefined;
    if (!job) return undefined;
    const updated: CronJob = {
      ...job,
      nextRunAt: result.nextRunAt,
      lastRunAt: result.ranAt,
      lastError: undefined,
      updatedAt: nowIso(),
    };
    const committed = await this._kv.atomic()
      .check(entry)
      .set(jobKey(id), updated)
      .delete(dueKey(job.nextRunAt, id))
      .set(dueKey(updated.nextRunAt, id), id)
      .delete(leaseKey(id))
      .commit();
    return committed.ok ? updated : undefined;
  }

  /** Marks a one-shot run successful and removes the completed job. */
  async completeOneShotRun(id: string, result: { ranAt: string }): Promise<CronJob | undefined> {
    const entry = await this._kv.get<CronJob>(jobKey(id));
    const job = entry.value ? normalizeJob(entry.value) : undefined;
    if (!job) return undefined;
    const completed: CronJob = { ...job, lastRunAt: result.ranAt, lastError: undefined, updatedAt: nowIso() };
    const committed = await this._kv.atomic()
      .check(entry)
      .delete(jobKey(id))
      .delete(chatKey(job.chatId, id))
      .delete(dueKey(job.nextRunAt, id))
      .delete(leaseKey(id))
      .commit();
    return committed.ok ? completed : undefined;
  }

  /** Records a failed run, advances the due index, and releases the lease. */
  async failRun(
    id: string,
    result: { failedAt: string; nextRunAt: string; error: string },
  ): Promise<CronJob | undefined> {
    const entry = await this._kv.get<CronJob>(jobKey(id));
    const job = entry.value ? normalizeJob(entry.value) : undefined;
    if (!job) return undefined;
    const updated: CronJob = {
      ...job,
      nextRunAt: result.nextRunAt,
      lastFailedAt: result.failedAt,
      lastError: result.error,
      updatedAt: nowIso(),
    };
    const committed = await this._kv.atomic()
      .check(entry)
      .set(jobKey(id), updated)
      .delete(dueKey(job.nextRunAt, id))
      .set(dueKey(updated.nextRunAt, id), id)
      .delete(leaseKey(id))
      .commit();
    return committed.ok ? updated : undefined;
  }

  /** Records a failed one-shot run, disables it, and removes it from the due index. */
  async failOneShotRun(id: string, result: { failedAt: string; error: string }): Promise<CronJob | undefined> {
    const entry = await this._kv.get<CronJob>(jobKey(id));
    const job = entry.value ? normalizeJob(entry.value) : undefined;
    if (!job) return undefined;
    const updated: CronJob = {
      ...job,
      enabled: false,
      lastFailedAt: result.failedAt,
      lastError: result.error,
      updatedAt: nowIso(),
    };
    const committed = await this._kv.atomic()
      .check(entry)
      .set(jobKey(id), updated)
      .delete(dueKey(job.nextRunAt, id))
      .delete(leaseKey(id))
      .commit();
    return committed.ok ? updated : undefined;
  }
}

function normalizeJob(job: CronJob): CronJob {
  return { ...job, sessionMode: job.sessionMode ?? "fresh" };
}

/** Stable label for cron job Telegram conversations. */
export function cronConversationLabel(job: Pick<CronJob, "chatId" | "threadId">): string {
  return `${job.chatId}:${telegramThreadKey(job.threadId)}`;
}
