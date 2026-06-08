import { withBrokerGrantScope } from "../permission-broker/mod.ts";
import { errorMessage } from "../shared/error.ts";
import { logDebug, logError } from "../shared/log.ts";
import type { CronCapabilityDelegate, CronPermissionBrokerRule, CronPermissionToolRule } from "./permissions.ts";
import { nextRunForSchedule } from "./schedule.ts";
import type { CronJob, CronJobStore } from "./store.ts";

/** Runs one leased cron job through the host application. */
export interface CronJobRunner {
  run(
    job: CronJob,
    capabilities: CronCapabilityDelegate,
    signal: AbortSignal,
    dispatchedAt: Date,
  ): Promise<CronJobRunnerResult>;
}

/** Terminal or queued outcome from a cron dispatch attempt. */
export type CronJobRunnerResult =
  | { status: "completed" }
  | { status: "submitted"; workId: string };

export interface CronDispatcherOptions {
  store: CronJobStore;
  capabilities: CronCapabilityDelegate;
  runner: CronJobRunner;
  signal: AbortSignal;
  leaseMs?: number;
}

/** Polls durable cron jobs and dispatches due runs. */
export class CronDispatcher {
  private readonly _store: CronJobStore;
  private readonly _capabilities: CronCapabilityDelegate;
  private readonly _runner: CronJobRunner;
  private readonly _signal: AbortSignal;
  private readonly _leaseMs: number;

  constructor(options: CronDispatcherOptions) {
    this._store = options.store;
    this._capabilities = options.capabilities;
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
    try {
      logDebug("cron.run.start", { jobId: job.id });
      const result = await withBrokerGrantScope(
        "once",
        () =>
          this._capabilities.withProfile(
            job.permissionProfile,
            job.id,
            () => this._runner.run(job, this._capabilities, this._signal, now),
            {
              onApprovedToolRule: (rule) => this._cacheToolRule(job.id, rule),
              onApprovedBrokerRule: (rule) => this._cacheBrokerRule(job.id, rule),
            },
          ),
      );
      if (result.status === "submitted") {
        logDebug("cron.run.submitted", { jobId: job.id, workId: result.workId });
        return;
      }
      const nextRunAt = nextRunForSchedule(job.schedule, now);
      if (nextRunAt) {
        await this._store.completeRun(job.id, { ranAt: now.toISOString(), nextRunAt });
      } else {
        await this._store.completeOneShotRun(job.id, { ranAt: now.toISOString() });
      }
      logDebug("cron.run.ok", { jobId: job.id, nextRunAt: nextRunAt ?? "complete" });
    } catch (error) {
      const message = errorMessage(error);
      logError("cron.run.error", { jobId: job.id, message });
      const nextRunAt = nextRunForSchedule(job.schedule, now);
      if (nextRunAt) {
        await this._store.failRun(job.id, {
          failedAt: now.toISOString(),
          nextRunAt,
          error: message,
        });
      } else {
        await this._store.failOneShotRun(job.id, {
          failedAt: now.toISOString(),
          error: message,
        });
      }
    }
  }

  private async _cacheToolRule(jobId: string, rule: CronPermissionToolRule): Promise<void> {
    try {
      await this._store.addPermissionRules(jobId, { toolRules: [rule] });
      logDebug("cron.permission_cached", { jobId, operation: rule.operation, target: rule.target });
    } catch (error) {
      const message = errorMessage(error);
      logError("cron.permission_cache_error", { jobId, message });
    }
  }

  private async _cacheBrokerRule(jobId: string, rule: CronPermissionBrokerRule): Promise<void> {
    try {
      await this._store.addPermissionRules(jobId, { brokerRules: [rule] });
      logDebug("cron.broker_permission_cached", {
        jobId,
        permission: rule.permission,
        value: rule.value ?? "(none)",
      });
    } catch (error) {
      const message = errorMessage(error);
      logError("cron.broker_permission_cache_error", { jobId, message });
    }
  }
}
