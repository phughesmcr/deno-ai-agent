import { assertEquals } from "jsr:@std/assert@1";

import {
  type CronCapabilityDelegate,
  CronDispatcher,
  type CronJob,
  type CronJobRunner,
  type CronJobRunnerResult,
  CronJobStore,
  type CronPermissionProfile,
} from "../../src/cron/mod.ts";
import type { CapabilityDelegateDecision, CapabilityRequest } from "../../src/core/mod.ts";

const input = {
  chatId: 1,
  prompt: "Check Gmail and summarize actions.",
  schedule: {
    kind: "recurring" as const,
    scheduleText: "Every morning at 8am",
    timezone: "Europe/London",
    cronExpression: "0 8 * * *",
    recurrence: { kind: "daily" as const, hour: 8, minute: 0 },
  },
  nextRunAt: "2026-06-06T07:00:00.000Z",
  permissionProfile: {
    toolRules: [],
    brokerRules: [],
  },
};

class FakeCronCapabilities implements CronCapabilityDelegate {
  decide(_request: CapabilityRequest): Promise<CapabilityDelegateDecision> {
    return Promise.resolve({
      decision: "deny",
      scope: "once",
      reason: "not used",
      decidedAt: "2026-06-08T09:00:00.000Z",
      decidedBy: "test",
    });
  }

  withProfile<T>(_profile: CronPermissionProfile, _jobId: string, operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

class ScriptedRunner implements CronJobRunner {
  readonly jobs: CronJob[] = [];
  results: Array<CronJobRunnerResult | Error> = [];

  run(job: CronJob): Promise<CronJobRunnerResult> {
    this.jobs.push(job);
    const result = this.results.shift();
    if (!result) throw new Error("No scripted cron runner result queued.");
    if (result instanceof Error) throw result;
    return Promise.resolve(result);
  }
}

async function withStore(fn: (store: CronJobStore) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(new CronJobStore(kv));
  } finally {
    kv.close();
  }
}

Deno.test({
  name: "CronDispatcher leaves a submitted durable run leased until a worker finishes it",
  permissions: { env: ["LOG_LEVEL"] },
  fn: async (): Promise<void> => {
    await withStore(async (store) => {
      const job = await store.create(input);
      const runner = new ScriptedRunner();
      runner.results.push({ status: "submitted", workId: "work-1" });
      const dispatcher = new CronDispatcher({
        store,
        capabilities: new FakeCronCapabilities(),
        runner,
        signal: new AbortController().signal,
      });

      await dispatcher.tick(new Date("2026-06-06T07:00:00.000Z"));
      await dispatcher.tick(new Date("2026-06-06T07:00:01.000Z"));

      assertEquals(runner.jobs.map((run) => run.id), [job.id]);
      assertEquals((await store.get(job.id))?.nextRunAt, "2026-06-06T07:00:00.000Z");
      assertEquals((await store.get(job.id))?.lastRunAt, undefined);
    });
  },
});

Deno.test({
  name: "CronDispatcher advances a job when a runner completes synchronously",
  permissions: { env: ["LOG_LEVEL"] },
  fn: async (): Promise<void> => {
    await withStore(async (store) => {
      const job = await store.create(input);
      const runner = new ScriptedRunner();
      runner.results.push({ status: "completed" });
      const dispatcher = new CronDispatcher({
        store,
        capabilities: new FakeCronCapabilities(),
        runner,
        signal: new AbortController().signal,
      });

      await dispatcher.tick(new Date("2026-06-06T07:00:00.000Z"));

      assertEquals((await store.get(job.id))?.lastRunAt, "2026-06-06T07:00:00.000Z");
      assertEquals((await store.get(job.id))?.nextRunAt, "2026-06-07T07:00:00.000Z");
    });
  },
});

Deno.test({
  name: "CronDispatcher records a failed runner result as cron failure",
  permissions: { env: ["LOG_LEVEL"] },
  fn: async (): Promise<void> => {
    await withStore(async (store) => {
      const job = await store.create(input);
      const runner = new ScriptedRunner();
      runner.results.push(new Error("model failed"));
      const dispatcher = new CronDispatcher({
        store,
        capabilities: new FakeCronCapabilities(),
        runner,
        signal: new AbortController().signal,
      });

      await dispatcher.tick(new Date("2026-06-06T07:00:00.000Z"));

      assertEquals((await store.get(job.id))?.lastFailedAt, "2026-06-06T07:00:00.000Z");
      assertEquals((await store.get(job.id))?.lastError, "model failed");
      assertEquals((await store.get(job.id))?.nextRunAt, "2026-06-07T07:00:00.000Z");
    });
  },
});
