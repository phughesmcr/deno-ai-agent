const DAILY_PATTERN = /^\s*every\s+(?:day|morning)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i;
const INTERVAL_PATTERN = /^\s*every\s+(\d+)\s+(minute|minutes|hour|hours)\s*$/i;

export interface ParsedCronNewInput {
  scheduleText: string;
  timezone: string;
  nextRunAt: string;
  prompt: string;
}

function parseDailySchedule(text: string): { hour: number; minute: number } | undefined {
  const match = DAILY_PATTERN.exec(text);
  if (!match?.[1]) return undefined;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (hour < 0 || hour > 23) return undefined;
  return { hour, minute };
}

function parseIntervalSchedule(text: string): { minutes: number } | undefined {
  const match = INTERVAL_PATTERN.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1) return undefined;
  const unit = match[2].toLowerCase();
  const minutes = unit.startsWith("hour") ? count * 60 : count;
  return { minutes };
}

/** Returns the next UTC daily run time strictly after `now`. */
export function nextDailyRunAtUtc(hour: number, minute: number, now = new Date()): string {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
    0,
    0,
  ));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** Returns the next UTC interval run time after `now`. */
export function nextIntervalRunAtUtc(minutes: number, now = new Date()): string {
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error("Interval minutes must be a positive integer.");
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

/** Parses `/cron new` input for the v1 natural-language daily schedule shape. */
export function parseCronNewInput(input: string, now = new Date()): ParsedCronNewInput {
  const separator = input.indexOf(",");
  if (separator < 0) {
    throw new Error("Usage: /cron new Every morning at 8am, <prompt>");
  }

  const scheduleText = input.slice(0, separator).trim();
  const prompt = input.slice(separator + 1).trim();
  if (!prompt) throw new Error("Cron prompt cannot be empty.");

  const daily = parseDailySchedule(scheduleText);
  if (daily) {
    return {
      scheduleText,
      timezone: "UTC",
      nextRunAt: nextDailyRunAtUtc(daily.hour, daily.minute, now),
      prompt,
    };
  }

  const interval = parseIntervalSchedule(scheduleText);
  if (interval) {
    return {
      scheduleText,
      timezone: "UTC",
      nextRunAt: nextIntervalRunAtUtc(interval.minutes, now),
      prompt,
    };
  }

  throw new Error("Unsupported schedule. Try: Every morning at 8am, <prompt> or every 2 minutes, <prompt>");
}

/** Computes the next run for a stored v1 daily schedule. */
export function nextRunForScheduleText(scheduleText: string, after = new Date()): string {
  const daily = parseDailySchedule(scheduleText);
  if (daily) return nextDailyRunAtUtc(daily.hour, daily.minute, after);
  const interval = parseIntervalSchedule(scheduleText);
  if (interval) return nextIntervalRunAtUtc(interval.minutes, after);
  throw new Error(`Unsupported cron schedule: ${scheduleText}`);
}
