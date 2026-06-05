import type { Tool } from "@lmstudio/sdk";

import type { UserInteractionPort, UserInteractionRequest } from "../agent/mod.ts";
import { parseMcpToolName } from "../mcp/naming.ts";
import type { CommandCronManager, CommandCronSummary } from "../telegram/commands.ts";
import type { TelegramConversationRef } from "../telegram/conversation.ts";
import type { CronPermissionProfile } from "./permissions.ts";
import {
  type CronScheduleExtractor,
  defaultCronTimezone,
  extractKnownCronSchedule,
  normalizeCronSchedule,
  type RawExtractedCronSchedule,
} from "./schedule.ts";
import type { CronJob, CronJobStore, CronSessionMode } from "./store.ts";

interface CronCommandManagerOptions {
  store: CronJobStore;
  ref: TelegramConversationRef;
  mcpTools: () => Tool[];
  scheduleExtractor?: CronScheduleExtractor;
  userInteraction?: UserInteractionPort;
  now?: () => Date;
  defaultTimezone?: () => string;
  createTopic?: (name: string) => Promise<{ threadId: number; topicName: string }>;
}

function toolName(tool: Tool): string {
  return (tool as { name: string }).name;
}

function promptMentionsServer(prompt: string, serverId: string): boolean {
  return new RegExp(`\\b${serverId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(prompt);
}

function inferPermissionProfile(prompt: string, tools: readonly Tool[]): CronPermissionProfile {
  const mcpRules = tools.flatMap((tool) => {
    const parsed = parseMcpToolName(toolName(tool));
    if (!parsed || !promptMentionsServer(prompt, parsed.serverId)) return [];
    return [{ operation: "mcp" as const, target: `${parsed.serverId}/${parsed.toolName}` }];
  });
  return { localToolPolicy: "workspace-readonly", toolRules: mcpRules, brokerRules: [] };
}

function permissionSummary(profile: CronPermissionProfile): string {
  const localPolicy = profile.localToolPolicy ?? "workspace-readonly";
  const localRules = localPolicy === "none" ? [] : [`local:${localPolicy}`];
  const toolRules = profile.toolRules.map((rule) => `${rule.operation}:${rule.target}`);
  const brokerRules = profile.brokerRules.map((rule) => `broker:${rule.permission}:${rule.value ?? "(none)"}`);
  const rules = [...localRules, ...toolRules, ...brokerRules];
  return rules.length === 0 ? "none" : rules.join(", ");
}

function toSummary(job: CronJob): CommandCronSummary {
  return {
    id: job.id,
    scheduleKind: job.schedule.kind,
    scheduleText: job.schedule.scheduleText,
    nextRunAt: job.nextRunAt,
    enabled: job.enabled,
    sessionMode: job.sessionMode,
    prompt: job.prompt,
    permissionSummary: permissionSummary(job.permissionProfile),
  };
}

function topicNameForSchedule(scheduleText: string): string {
  return `Cron: ${scheduleText}`.slice(0, 128);
}

function extractorRequired(): never {
  throw new Error("Cron schedule extraction is not configured.");
}

function clarificationRequest(question: string): UserInteractionRequest {
  return {
    mode: "mcp_form",
    serverId: "silas",
    serverTitle: "Silas",
    message: question,
    requestedSchema: {
      type: "object",
      properties: {
        time: {
          type: "string",
          title: "Time",
          description: question,
        },
      },
      required: ["time"],
    },
  };
}

function acceptedClarification(content: Record<string, unknown> | undefined): string {
  const value = content?.["time"];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  throw new Error("Cron schedule clarification did not include a time.");
}

/** KV-backed cron command adapter for one Telegram conversation. */
export class CronCommandManager implements CommandCronManager {
  private readonly _store: CronJobStore;
  private readonly _ref: TelegramConversationRef;
  private readonly _mcpTools: () => Tool[];
  private readonly _scheduleExtractor?: CronScheduleExtractor;
  private readonly _userInteraction?: UserInteractionPort;
  private readonly _now: () => Date;
  private readonly _defaultTimezone: () => string;
  private readonly _createTopic?: (name: string) => Promise<{ threadId: number; topicName: string }>;

  constructor(options: CronCommandManagerOptions) {
    this._store = options.store;
    this._ref = options.ref;
    this._mcpTools = options.mcpTools;
    this._scheduleExtractor = options.scheduleExtractor;
    this._userInteraction = options.userInteraction;
    this._now = options.now ?? (() => new Date());
    this._defaultTimezone = options.defaultTimezone ?? defaultCronTimezone;
    this._createTopic = options.createTopic;
  }

  private async _extract(input: string, now: Date, defaultTimezone: string): Promise<RawExtractedCronSchedule> {
    const known = extractKnownCronSchedule(input);
    if (known) return known;
    const extractor = this._scheduleExtractor ?? extractorRequired();
    const first = await extractor.extractCronSchedule({ input, now, defaultTimezone });
    if (first.status !== "needs_clarification") return first;
    if (!this._userInteraction?.isAvailable()) throw new Error(first.question);
    const result = await this._userInteraction.interact(clarificationRequest(first.question));
    if (result.action !== "accept") throw new Error("Cron creation cancelled.");
    const clarification = acceptedClarification(result.content);
    return await extractor.extractCronSchedule({ input, now, defaultTimezone, clarification });
  }

  async create(input: string): Promise<string> {
    const now = this._now();
    const defaultTimezone = this._defaultTimezone();
    const raw = await this._extract(input, now, defaultTimezone);
    const parsed = normalizeCronSchedule(raw, { now, defaultTimezone });
    const profile = inferPermissionProfile(parsed.prompt, this._mcpTools());
    if (!this._createTopic) throw new Error("Cron jobs require a Telegram forum topic.");
    const topic = await this._createTopic(topicNameForSchedule(parsed.schedule.scheduleText));
    const job = await this._store.create({
      chatId: this._ref.chatId,
      threadId: topic.threadId,
      prompt: parsed.prompt,
      schedule: parsed.schedule,
      nextRunAt: parsed.nextRunAt,
      permissionProfile: profile,
      topicName: topic.topicName,
    });
    return [
      `Created cron job ${job.id}.`,
      `Topic: ${topic.topicName}`,
      `Next run: ${job.nextRunAt}`,
      `Permissions: ${permissionSummary(job.permissionProfile)}`,
    ].join("\n");
  }

  async list(): Promise<CommandCronSummary[]> {
    return (await this._store.listForChat(this._ref.chatId)).map(toSummary);
  }

  async delete(id: string): Promise<boolean> {
    return (await this._store.delete(id)) !== undefined;
  }

  async setMode(id: string, mode: CronSessionMode): Promise<boolean> {
    return (await this._store.setSessionMode(id, mode)) !== undefined;
  }
}
