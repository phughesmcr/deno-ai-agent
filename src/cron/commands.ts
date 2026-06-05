import type { Tool } from "@lmstudio/sdk";

import { parseMcpToolName } from "../mcp/naming.ts";
import type { CommandCronManager, CommandCronSummary } from "../telegram/commands.ts";
import type { TelegramConversationRef } from "../telegram/conversation.ts";
import type { CronPermissionProfile } from "./permissions.ts";
import { parseCronNewInput } from "./schedule.ts";
import type { CronJob, CronJobStore } from "./store.ts";

interface CronCommandManagerOptions {
  store: CronJobStore;
  ref: TelegramConversationRef;
  mcpTools: () => Tool[];
  createTopic?: (name: string) => Promise<{ threadId: number; topicName: string }>;
}

function toolName(tool: Tool): string {
  return (tool as { name: string }).name;
}

function promptMentionsServer(prompt: string, serverId: string): boolean {
  return new RegExp(`\\b${serverId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(prompt);
}

function inferPermissionProfile(prompt: string, tools: readonly Tool[]): CronPermissionProfile {
  const toolRules = tools.flatMap((tool) => {
    const parsed = parseMcpToolName(toolName(tool));
    if (!parsed || !promptMentionsServer(prompt, parsed.serverId)) return [];
    return [{ operation: "mcp" as const, target: `${parsed.serverId}/${parsed.toolName}` }];
  });
  return { toolRules, brokerRules: [] };
}

function permissionSummary(profile: CronPermissionProfile): string {
  const toolRules = profile.toolRules.map((rule) => `${rule.operation}:${rule.target}`);
  const brokerRules = profile.brokerRules.map((rule) => `broker:${rule.permission}:${rule.value ?? "(none)"}`);
  const rules = [...toolRules, ...brokerRules];
  return rules.length === 0 ? "none" : rules.join(", ");
}

function toSummary(job: CronJob): CommandCronSummary {
  return {
    id: job.id,
    scheduleText: job.scheduleText,
    nextRunAt: job.nextRunAt,
    enabled: job.enabled,
    prompt: job.prompt,
    permissionSummary: permissionSummary(job.permissionProfile),
  };
}

function topicNameForSchedule(scheduleText: string): string {
  return `Cron: ${scheduleText}`.slice(0, 128);
}

/** KV-backed cron command adapter for one Telegram conversation. */
export class CronCommandManager implements CommandCronManager {
  private readonly _store: CronJobStore;
  private readonly _ref: TelegramConversationRef;
  private readonly _mcpTools: () => Tool[];
  private readonly _createTopic?: (name: string) => Promise<{ threadId: number; topicName: string }>;

  constructor(options: CronCommandManagerOptions) {
    this._store = options.store;
    this._ref = options.ref;
    this._mcpTools = options.mcpTools;
    this._createTopic = options.createTopic;
  }

  async create(input: string): Promise<string> {
    const parsed = parseCronNewInput(input);
    const profile = inferPermissionProfile(parsed.prompt, this._mcpTools());
    if (!this._createTopic) throw new Error("Cron jobs require a Telegram forum topic.");
    const topic = await this._createTopic(topicNameForSchedule(parsed.scheduleText));
    const job = await this._store.create({
      chatId: this._ref.chatId,
      threadId: topic.threadId,
      prompt: parsed.prompt,
      scheduleText: parsed.scheduleText,
      timezone: parsed.timezone,
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
}
