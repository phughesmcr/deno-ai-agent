import { assertEquals } from "jsr:@std/assert@1";

import { CronCommandManager } from "../../src/cron/commands.ts";
import type { CronScheduleExtractor, RawExtractedCronSchedule } from "../../src/cron/schedule.ts";
import { CronJobStore } from "../../src/cron/store.ts";
import type { UserInteractionPort, UserInteractionRequest, UserInteractionResult } from "../../src/agent/mod.ts";

async function withStore(fn: (store: CronJobStore) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(new CronJobStore(kv));
  } finally {
    kv.close();
  }
}

class FakeScheduleExtractor implements CronScheduleExtractor {
  readonly requests: { input: string; now: Date; defaultTimezone: string; clarification?: string }[] = [];
  replies: RawExtractedCronSchedule[] = [];

  extractCronSchedule(request: {
    input: string;
    now: Date;
    defaultTimezone: string;
    clarification?: string;
  }): Promise<RawExtractedCronSchedule> {
    this.requests.push(request);
    const reply = this.replies.shift();
    if (!reply) throw new Error("No fake extractor reply queued.");
    return Promise.resolve(reply);
  }
}

class FakeUserInteraction implements UserInteractionPort {
  readonly requests: UserInteractionRequest[] = [];
  answer = "10am";

  isAvailable(): boolean {
    return true;
  }

  isPending(): boolean {
    return false;
  }

  setTurnContext(): void {}

  clearTurnContext(): void {}

  interact(request: UserInteractionRequest): Promise<UserInteractionResult> {
    this.requests.push(request);
    return Promise.resolve({ action: "accept", content: { time: this.answer } });
  }
}

Deno.test("CronCommandManager creates a dedicated topic for new recurring jobs", async () => {
  await withStore(async (store) => {
    const extractor = new FakeScheduleExtractor();
    extractor.replies.push({
      status: "ok",
      prompt: 'prompt me "WAKE UP!!"',
      scheduleText: "every 2 minutes",
      schedule: {
        kind: "recurring",
        recurrence: { kind: "interval", every: 2, unit: "minute" },
        timezone: "UTC",
      },
    });
    const manager = new CronCommandManager({
      store,
      ref: { chatId: 123, threadId: 10 },
      mcpTools: () => [],
      scheduleExtractor: extractor,
      now: () => new Date("2026-06-05T16:19:47.000Z"),
      createTopic: (name) => {
        assertEquals(name, "Cron: every 2 minutes");
        return Promise.resolve({ threadId: 99, topicName: name });
      },
    });

    const text = await manager.create('every 2 minutes, prompt me "WAKE UP!!"');
    const jobs = await store.listForChat(123);

    assertEquals(jobs.length, 1);
    assertEquals(jobs[0]?.threadId, 99);
    assertEquals(jobs[0]?.topicName, "Cron: every 2 minutes");
    assertEquals(jobs[0]?.schedule.kind, "recurring");
    assertEquals(jobs[0]?.nextRunAt, "2026-06-05T16:21:47.000Z");
    assertEquals(text.includes("Topic: Cron: every 2 minutes"), true);
  });
});

Deno.test("CronCommandManager gives new jobs a workspace read-only local policy", async () => {
  await withStore(async (store) => {
    const extractor = new FakeScheduleExtractor();
    extractor.replies.push({
      status: "ok",
      prompt: "ls the cwd",
      scheduleText: "every 2 minutes",
      schedule: {
        kind: "recurring",
        recurrence: { kind: "interval", every: 2, unit: "minute" },
        timezone: "UTC",
      },
    });
    const manager = new CronCommandManager({
      store,
      ref: { chatId: 123, threadId: 10 },
      mcpTools: () => [],
      scheduleExtractor: extractor,
      now: () => new Date("2026-06-05T16:19:47.000Z"),
      createTopic: (name) => Promise.resolve({ threadId: 99, topicName: name }),
    });

    const text = await manager.create("every 2 minutes, ls the cwd");
    const jobs = await store.listForChat(123);

    assertEquals(jobs[0]?.permissionProfile.localToolPolicy, "workspace-readonly");
    assertEquals(jobs[0]?.permissionProfile.toolRules, []);
    assertEquals(text.includes("Permissions: local:workspace-readonly"), true);
  });
});

Deno.test("CronCommandManager asks for missing one-shot time before creating the job", async () => {
  await withStore(async (store) => {
    const extractor = new FakeScheduleExtractor();
    extractor.replies.push(
      {
        status: "needs_clarification",
        prompt: "prompt me about the appointment",
        scheduleText: "next Tuesday",
        question: "What time should I remind you?",
      },
      {
        status: "ok",
        prompt: "prompt me about the appointment",
        scheduleText: "next Tuesday",
        schedule: {
          kind: "once",
          date: { kind: "next_weekday", weekday: "tuesday" },
          time: "10:00",
          timezone: "Europe/London",
        },
      },
    );
    const userInteraction = new FakeUserInteraction();
    const manager = new CronCommandManager({
      store,
      ref: { chatId: 123, threadId: 10 },
      mcpTools: () => [],
      scheduleExtractor: extractor,
      userInteraction,
      now: () => new Date("2026-06-05T16:19:47.000Z"),
      defaultTimezone: () => "Europe/London",
      createTopic: (name) => Promise.resolve({ threadId: 99, topicName: name }),
    });

    await manager.create("next Tuesday, prompt me about the appointment");
    const jobs = await store.listForChat(123);

    assertEquals(extractor.requests.map((request) => request.clarification), [undefined, "10am"]);
    assertEquals(userInteraction.requests.length, 1);
    assertEquals(jobs[0]?.schedule.kind, "once");
    assertEquals(jobs[0]?.nextRunAt, "2026-06-09T09:00:00.000Z");
  });
});

Deno.test("CronCommandManager changes cron session mode", async () => {
  await withStore(async (store) => {
    const created = await store.create({
      chatId: 123,
      threadId: 99,
      prompt: "Review code",
      schedule: {
        kind: "recurring",
        scheduleText: "every 1 hours",
        timezone: "UTC",
        cronExpression: "0 */1 * * *",
        recurrence: { kind: "interval", every: 1, unit: "hour" },
      },
      nextRunAt: "2026-06-06T08:00:00.000Z",
      permissionProfile: { toolRules: [], brokerRules: [] },
    });
    const manager = new CronCommandManager({
      store,
      ref: { chatId: 123 },
      mcpTools: () => [],
    });

    assertEquals(await manager.setMode(created.id, "persistent"), true);
    assertEquals((await store.get(created.id))?.sessionMode, "persistent");
  });
});
