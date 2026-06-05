import { assertEquals } from "jsr:@std/assert@1";

import {
  nextDailyRunAtUtc,
  nextIntervalRunAtUtc,
  nextRunForScheduleText,
  parseCronNewInput,
} from "../../src/cron/schedule.ts";

Deno.test("parseCronNewInput parses every morning natural language command", () => {
  const parsed = parseCronNewInput(
    "Every morning at 8am, check my emails using the gmail mcp server tools and write me a list of actions",
    new Date("2026-06-05T12:00:00.000Z"),
  );

  assertEquals(parsed, {
    prompt: "check my emails using the gmail mcp server tools and write me a list of actions",
    scheduleText: "Every morning at 8am",
    timezone: "UTC",
    nextRunAt: "2026-06-06T08:00:00.000Z",
  });
});

Deno.test("parseCronNewInput parses every-n-minutes natural language command", () => {
  const parsed = parseCronNewInput(
    'every 2 minutes, prompt me "WAKE UP!!"',
    new Date("2026-06-05T16:19:47.000Z"),
  );

  assertEquals(parsed, {
    prompt: 'prompt me "WAKE UP!!"',
    scheduleText: "every 2 minutes",
    timezone: "UTC",
    nextRunAt: "2026-06-05T16:21:47.000Z",
  });
});

Deno.test("nextDailyRunAtUtc returns today when the time has not passed", () => {
  assertEquals(
    nextDailyRunAtUtc(8, 0, new Date("2026-06-05T07:59:00.000Z")),
    "2026-06-05T08:00:00.000Z",
  );
});

Deno.test("nextDailyRunAtUtc returns tomorrow when the time has passed", () => {
  assertEquals(
    nextDailyRunAtUtc(8, 0, new Date("2026-06-05T08:00:00.000Z")),
    "2026-06-06T08:00:00.000Z",
  );
});

Deno.test("nextIntervalRunAtUtc adds interval minutes to the current time", () => {
  assertEquals(
    nextIntervalRunAtUtc(2, new Date("2026-06-05T16:19:47.000Z")),
    "2026-06-05T16:21:47.000Z",
  );
});

Deno.test("nextRunForScheduleText supports interval schedules", () => {
  assertEquals(
    nextRunForScheduleText("every 2 minutes", new Date("2026-06-05T16:21:47.000Z")),
    "2026-06-05T16:23:47.000Z",
  );
});
