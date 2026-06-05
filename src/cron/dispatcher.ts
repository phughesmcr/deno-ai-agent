import type { ApprovalGate } from "../shared/approval.ts";
import { withBrokerGrantScope } from "../permission-broker/mod.ts";
import { logDebug, logError } from "../shared/log.ts";
import { createCronApprovalGate, type CronPermissionPromptPort } from "./permissions.ts";
import { nextRunForScheduleText } from "./schedule.ts";
import type { CronJob, CronJobStore } from "./store.ts";

/** Runs one leased cron job through the host application. */
export interface CronJobRunner {
  run(job: CronJob, approvalGate: ApprovalGate, signal: AbortSignal): Promise<void>;
}

export interface CronDispatcherOptions {
  store: CronJobStore;
  permissionPrompts: CronPermissionPromptPort;
  runner: CronJobRunner;
  signal: AbortSignal;
  leaseMs?: number;
}

/** Polls durable cron jobs and dispatches due runs. */
export class CronDispatcher {
  private readonly _store: CronJobStore;
  private readonly _permissionPrompts: CronPermissionPromptPort;
  private readonly _runner: CronJobRunner;
  private readonly _signal: AbortSignal;
  private readonly _leaseMs: number;

  constructor(options: CronDispatcherOptions) {
    this._store = options.store;
    this._permissionPrompts = options.permissionPrompts;
    this._runner = options.runner;
    this._signal = options.signal;
    this._leaseMs = options.leaseMs ?? 15 * 60 * 1000;
  }

  /** Executes all due jobs as of `now`, subject to per-job leases. */
  async tick(now = new Date()): Promise<void> {
    if (this._signal.aborted) return;
    const nowIso = now.toISOString();
    const due = await this._store.listDue(nowIso);
    for (const candidate of due) {
      if (this._signal.aborted) return;
      // deno-lint-ignore no-await-in-loop -- Cron jobs share one agent/session coordinator and must run sequentially.
      const job = await this._store.acquireLease(candidate.id, nowIso, this._leaseMs);
      if (!job) continue;
      // deno-lint-ignore no-await-in-loop -- See above; the runner serializes through the agent coordinator.
      await this._runLeased(job, now);
    }
  }

  async _runLeased(job: CronJob, now: Date): Promise<void> {
    const approvalGate = createCronApprovalGate(job.permissionProfile, job.id);
    try {
      logDebug("cron.run.start", { jobId: job.id });
      await withBrokerGrantScope(
        "once",
        () =>
          this._permissionPrompts.withProfile(
            job.permissionProfile,
            job.id,
            () => this._runner.run(job, approvalGate, this._signal),
          ),
      );
      const nextRunAt = nextRunForScheduleText(job.scheduleText, now);
      await this._store.completeRun(job.id, { ranAt: now.toISOString(), nextRunAt });
      logDebug("cron.run.ok", { jobId: job.id, nextRunAt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError("cron.run.error", { jobId: job.id, message });
      const nextRunAt = nextRunForScheduleText(job.scheduleText, now);
      await this._store.failRun(job.id, {
        failedAt: now.toISOString(),
        nextRunAt,
        error: message,
      });
    }
  }
}
