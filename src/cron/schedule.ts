import { z } from "zod/v3";

export type Weekday = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export type CronRecurrence =
  | { kind: "interval"; every: number; unit: "minute" | "hour" }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: Weekday; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number };

export interface RecurringCronSchedule {
  kind: "recurring";
  scheduleText: string;
  timezone: string;
  cronExpression: string;
  recurrence: CronRecurrence;
}

export interface OneShotCronSchedule {
  kind: "once";
  scheduleText: string;
  timezone: string;
  runAt: string;
}

export type CronSchedule = RecurringCronSchedule | OneShotCronSchedule;

export type RawOneShotDate =
  | { kind: "date"; date: string }
  | { kind: "next_weekday"; weekday: Weekday };

export type RawExtractedCronSchedule =
  | {
    status: "ok";
    prompt: string;
    scheduleText: string;
    schedule:
      | { kind: "recurring"; timezone?: string; recurrence: CronRecurrence }
      | { kind: "once"; timezone?: string; date: RawOneShotDate; time: string };
  }
  | { status: "needs_clarification"; prompt?: string; scheduleText?: string; question: string }
  | { status: "unsupported"; message: string };

export interface NormalizedCronSchedule {
  prompt: string;
  schedule: CronSchedule;
  nextRunAt: string;
}

export interface NormalizeCronScheduleOptions {
  now: Date;
  defaultTimezone: string;
}

export interface CronScheduleExtractionRequest {
  input: string;
  now: Date;
  defaultTimezone: string;
  clarification?: string;
  signal?: AbortSignal;
}

export interface CronScheduleExtractor {
  extractCronSchedule(request: CronScheduleExtractionRequest): Promise<RawExtractedCronSchedule>;
}

const bareTimeScheduleMessage =
  "I found a time but not a date or recurrence. Try `/cron new daily at 9am, <prompt>` or `/cron new next Tuesday at 9am, <prompt>`.";
const weekdaySchema = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const temporal = globalThis.Temporal;
type TemporalInstant = ReturnType<typeof globalThis.Temporal.Instant.from>;
type TemporalPlainDate = ReturnType<typeof globalThis.Temporal.PlainDate.from>;

const recurrenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("interval"),
    every: z.number().int().positive(),
    unit: z.enum(["minute", "hour"]),
  }),
  z.object({
    kind: z.literal("daily"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("weekly"),
    weekday: weekdaySchema,
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.object({
    kind: z.literal("weekdays"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
]);

const rawScheduleSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    prompt: z.string().min(1),
    scheduleText: z.string().min(1),
    schedule: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("recurring"),
        timezone: z.string().min(1).optional(),
        recurrence: recurrenceSchema,
      }),
      z.object({
        kind: z.literal("once"),
        timezone: z.string().min(1).optional(),
        date: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
          z.object({ kind: z.literal("next_weekday"), weekday: weekdaySchema }),
        ]),
        time: z.string().regex(/^\d{2}:\d{2}$/),
      }),
    ]),
  }),
  z.object({
    status: z.literal("needs_clarification"),
    prompt: z.string().min(1).optional(),
    scheduleText: z.string().min(1).optional(),
    question: z.string().min(1),
  }),
  z.object({
    status: z.literal("unsupported"),
    message: z.string().min(1),
  }),
]);

const weekdayNumber: Record<Weekday, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

function toCronDay(weekday: Weekday): number {
  const value = weekdayNumber[weekday];
  return value === 7 ? 0 : value;
}

function ensureTimezone(timezone: string): string {
  try {
    temporal.Now.zonedDateTimeISO(timezone);
    return timezone;
  } catch {
    throw new Error(`Unsupported timezone: ${timezone}`);
  }
}

function instantIso(instant: TemporalInstant): string {
  return new Date(instant.epochMilliseconds).toISOString();
}

function zonedDateTimeIso(
  date: TemporalPlainDate,
  time: { hour: number; minute: number },
  timezone: string,
): string {
  const zoned = temporal.ZonedDateTime.from({
    timeZone: timezone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    second: 0,
    millisecond: 0,
    microsecond: 0,
    nanosecond: 0,
  });
  return instantIso(zoned.toInstant());
}

function parseTime(time: string): { hour: number; minute: number } {
  const [hourText, minuteText] = time.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid schedule time: ${time}`);
  }
  return { hour, minute };
}

function splitScheduleAndPrompt(input: string): { scheduleText: string; prompt: string } | undefined {
  const commaIndex = input.indexOf(",");
  if (commaIndex < 0) return undefined;
  const scheduleText = input.slice(0, commaIndex).trim();
  const prompt = input.slice(commaIndex + 1).trim();
  if (!scheduleText || !prompt) return undefined;
  return { scheduleText, prompt };
}

function timeFromScheduleText(scheduleText: string): { hour: number; minute: number } | undefined {
  const match = /\b(?:at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<period>am|pm)?\b/i.exec(scheduleText);
  const groups = match?.groups;
  if (!groups) return undefined;
  const rawHour = Number(groups["hour"]);
  const minute = groups["minute"] === undefined ? 0 : Number(groups["minute"]);
  const period = groups["period"]?.toLowerCase();
  if (!Number.isInteger(rawHour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  if (period === undefined) {
    if (rawHour < 0 || rawHour > 23) return undefined;
    return { hour: rawHour, minute };
  }
  if (rawHour < 1 || rawHour > 12) return undefined;
  const hour = period === "am" ? rawHour % 12 : rawHour === 12 ? 12 : rawHour + 12;
  return { hour, minute };
}

function isDailyScheduleText(scheduleText: string): boolean {
  return /\b(daily|every\s+day|each\s+day)\b/i.test(scheduleText);
}

function isBareTimeScheduleText(scheduleText: string): boolean {
  return /^\s*at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*$/i.test(scheduleText);
}

/** Parses high-confidence cron phrases without involving an LLM. */
export function extractKnownCronSchedule(input: string): RawExtractedCronSchedule | undefined {
  const parts = splitScheduleAndPrompt(input);
  if (!parts) return undefined;
  const time = timeFromScheduleText(parts.scheduleText);
  if (!time) return undefined;
  if (isDailyScheduleText(parts.scheduleText)) {
    return {
      status: "ok",
      prompt: parts.prompt,
      scheduleText: parts.scheduleText,
      schedule: {
        kind: "recurring",
        recurrence: { kind: "daily", hour: time.hour, minute: time.minute },
      },
    };
  }
  if (isBareTimeScheduleText(parts.scheduleText)) {
    return { status: "unsupported", message: bareTimeScheduleMessage };
  }
  return undefined;
}

function nextWeekdayDate(weekday: Weekday, now: Date, timezone: string): TemporalPlainDate {
  const nowZoned = temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(timezone);
  const target = weekdayNumber[weekday];
  let days = target - nowZoned.dayOfWeek;
  if (days <= 0) days += 7;
  return nowZoned.toPlainDate().add({ days });
}

function resolveOneShotRunAt(
  date: RawOneShotDate,
  timeText: string,
  now: Date,
  timezone: string,
): string {
  const time = parseTime(timeText);
  const plainDate = date.kind === "date" ?
    temporal.PlainDate.from(date.date) :
    nextWeekdayDate(date.weekday, now, timezone);
  const runAt = zonedDateTimeIso(plainDate, time, timezone);
  if (runAt <= now.toISOString()) throw new Error("One-shot cron schedule must be in the future.");
  return runAt;
}

function nextDailyRunAt(recurrence: { hour: number; minute: number }, after: Date, timezone: string): string {
  const afterInstant = temporal.Instant.from(after.toISOString());
  const afterZoned = afterInstant.toZonedDateTimeISO(timezone);
  let date = afterZoned.toPlainDate();
  let candidate = zonedDateTimeIso(date, recurrence, timezone);
  if (candidate <= after.toISOString()) {
    date = date.add({ days: 1 });
    candidate = zonedDateTimeIso(date, recurrence, timezone);
  }
  return candidate;
}

function nextWeeklyRunAt(
  recurrence: { weekday: Weekday; hour: number; minute: number },
  after: Date,
  timezone: string,
): string {
  const afterZoned = temporal.Instant.from(after.toISOString()).toZonedDateTimeISO(timezone);
  const target = weekdayNumber[recurrence.weekday];
  let days = target - afterZoned.dayOfWeek;
  if (days < 0) days += 7;
  let date = afterZoned.toPlainDate().add({ days });
  let candidate = zonedDateTimeIso(date, recurrence, timezone);
  if (candidate <= after.toISOString()) {
    date = date.add({ days: 7 });
    candidate = zonedDateTimeIso(date, recurrence, timezone);
  }
  return candidate;
}

function nextWeekdayRunAt(recurrence: { hour: number; minute: number }, after: Date, timezone: string): string {
  const afterZoned = temporal.Instant.from(after.toISOString()).toZonedDateTimeISO(timezone);
  const date = afterZoned.toPlainDate();
  for (let offset = 0; offset <= 7; offset++) {
    const candidateDate = date.add({ days: offset });
    const day = candidateDate.dayOfWeek;
    if (day > 5) continue;
    const candidate = zonedDateTimeIso(candidateDate, recurrence, timezone);
    if (candidate > after.toISOString()) return candidate;
  }
  throw new Error("Could not compute next weekday run.");
}

export function defaultCronTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function parseRawExtractedCronSchedule(value: unknown): RawExtractedCronSchedule {
  return rawScheduleSchema.parse(value) as RawExtractedCronSchedule;
}

export function cronExpressionForRecurrence(recurrence: CronRecurrence): string {
  switch (recurrence.kind) {
    case "interval":
      if (recurrence.unit === "minute") {
        return recurrence.every === 1 ? "* * * * *" : `*/${recurrence.every} * * * *`;
      }
      return recurrence.every === 1 ? "0 * * * *" : `0 */${recurrence.every} * * *`;
    case "daily":
      return `${recurrence.minute} ${recurrence.hour} * * *`;
    case "weekly":
      return `${recurrence.minute} ${recurrence.hour} * * ${toCronDay(recurrence.weekday)}`;
    case "weekdays":
      return `${recurrence.minute} ${recurrence.hour} * * 1-5`;
  }
}

export function nextRunForSchedule(schedule: CronSchedule, after = new Date()): string | undefined {
  if (schedule.kind === "once") return undefined;

  const timezone = ensureTimezone(schedule.timezone);
  const { recurrence } = schedule;
  switch (recurrence.kind) {
    case "interval": {
      const minutes = recurrence.unit === "hour" ? recurrence.every * 60 : recurrence.every;
      return new Date(after.getTime() + minutes * 60 * 1000).toISOString();
    }
    case "daily":
      return nextDailyRunAt(recurrence, after, timezone);
    case "weekly":
      return nextWeeklyRunAt(recurrence, after, timezone);
    case "weekdays":
      return nextWeekdayRunAt(recurrence, after, timezone);
  }
}

export function normalizeCronSchedule(
  raw: RawExtractedCronSchedule,
  options: NormalizeCronScheduleOptions,
): NormalizedCronSchedule {
  if (raw.status === "needs_clarification") throw new Error(raw.question);
  if (raw.status === "unsupported") throw new Error(raw.message);

  const timezone = ensureTimezone(raw.schedule.timezone ?? options.defaultTimezone);
  if (raw.schedule.kind === "recurring") {
    const schedule: RecurringCronSchedule = {
      kind: "recurring",
      scheduleText: raw.scheduleText,
      timezone,
      cronExpression: cronExpressionForRecurrence(raw.schedule.recurrence),
      recurrence: raw.schedule.recurrence,
    };
    const nextRunAt = nextRunForSchedule(schedule, options.now);
    if (!nextRunAt) throw new Error("Recurring cron schedule did not produce a next run.");
    return { prompt: raw.prompt, schedule, nextRunAt };
  }

  const runAt = resolveOneShotRunAt(raw.schedule.date, raw.schedule.time, options.now, timezone);
  return {
    prompt: raw.prompt,
    schedule: {
      kind: "once",
      scheduleText: raw.scheduleText,
      timezone,
      runAt,
    },
    nextRunAt: runAt,
  };
}
