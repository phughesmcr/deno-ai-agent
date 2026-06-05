import { assertEquals } from "jsr:@std/assert@1";

import {
  cronExpressionForRecurrence,
  nextRunForSchedule,
  normalizeCronSchedule,
  type RawExtractedCronSchedule,
} from "../../src/cron/schedule.ts";

Deno.test("cronExpressionForRecurrence supports every minute", () => {
  assertEquals(cronExpressionForRecurrence({ kind: "interval", every: 1, unit: "minute" }), "* * * * *");
});

Deno.test("normalizeCronSchedule resolves recurring interval schedules", () => {
  const raw: RawExtractedCronSchedule = {
    status: "ok",
    prompt: "ls the cwd",
    scheduleText: "every minute",
    schedule: {
      kind: "recurring",
      recurrence: { kind: "interval", every: 1, unit: "minute" },
    },
  };

  const normalized = normalizeCronSchedule(raw, {
    now: new Date("2026-06-05T16:19:47.000Z"),
    defaultTimezone: "Europe/London",
  });

  assertEquals(normalized, {
    prompt: "ls the cwd",
    schedule: {
      kind: "recurring",
      scheduleText: "every minute",
      timezone: "Europe/London",
      cronExpression: "* * * * *",
      recurrence: { kind: "interval", every: 1, unit: "minute" },
    },
    nextRunAt: "2026-06-05T16:20:47.000Z",
  });
});

Deno.test("normalizeCronSchedule resolves next weekday one-shot schedules with Temporal", () => {
  const raw: RawExtractedCronSchedule = {
    status: "ok",
    prompt: "prompt me about the appointment",
    scheduleText: "next Tuesday",
    schedule: {
      kind: "once",
      date: { kind: "next_weekday", weekday: "tuesday" },
      time: "10:00",
    },
  };

  const normalized = normalizeCronSchedule(raw, {
    now: new Date("2026-06-05T16:19:47.000Z"),
    defaultTimezone: "Europe/London",
  });

  assertEquals(normalized, {
    prompt: "prompt me about the appointment",
    schedule: {
      kind: "once",
      scheduleText: "next Tuesday",
      timezone: "Europe/London",
      runAt: "2026-06-09T09:00:00.000Z",
    },
    nextRunAt: "2026-06-09T09:00:00.000Z",
  });
});

Deno.test("nextRunForSchedule advances recurring schedules and leaves one-shot schedules without a next run", () => {
  assertEquals(
    nextRunForSchedule(
      {
        kind: "recurring",
        scheduleText: "every 2 minutes",
        timezone: "UTC",
        cronExpression: "*/2 * * * *",
        recurrence: { kind: "interval", every: 2, unit: "minute" },
      },
      new Date("2026-06-05T16:21:47.000Z"),
    ),
    "2026-06-05T16:23:47.000Z",
  );
  assertEquals(
    nextRunForSchedule(
      {
        kind: "once",
        scheduleText: "next Tuesday",
        timezone: "Europe/London",
        runAt: "2026-06-09T09:00:00.000Z",
      },
      new Date("2026-06-09T09:00:00.000Z"),
    ),
    undefined,
  );
});
