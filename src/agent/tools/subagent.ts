import type { Tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import type { SubagentPort, SubagentRecord } from "../subagents.ts";
import { type AgentToolDefinition, type AgentToolDeps, toolFromDefinition } from "./definitions.ts";

/** Supported model-facing actions for the `subagent` tool. */
export type SubagentAction = "spawn" | "status" | "list" | "result" | "cancel";

const SUBAGENT_ACTION_VALUES = ["spawn", "status", "list", "result", "cancel"] as const;
const SUBAGENT_ACTIONS: readonly SubagentAction[] = SUBAGENT_ACTION_VALUES;

/** Parameters accepted by the `subagent` tool. */
export interface SubagentToolParams {
  /** Action to perform. */
  action: SubagentAction;
  /** Required task prompt for `spawn`. */
  task?: string;
  /** Optional short title for `spawn`. */
  title?: string;
  /** Required subagent id for `status`, `result`, and `cancel`. */
  ["subagent_id"]?: string;
}

/** Stable JSON response shape returned by the `subagent` tool. */
export type SubagentToolResponse =
  | { ok: true; action: SubagentAction; subagent: SubagentRecord }
  | { ok: true; action: "list"; subagents: SubagentRecord[] }
  | { ok: false; action: SubagentAction | string; error: string };

function isSubagentAction(value: string): value is SubagentAction {
  return SUBAGENT_ACTIONS.includes(value as SubagentAction);
}

function json(response: SubagentToolResponse): string {
  return JSON.stringify(response);
}

function error(action: SubagentAction | string, message: string): string {
  return json({ ok: false, action, error: message });
}

function subagent(action: SubagentAction, record: SubagentRecord): string {
  return json({ ok: true, action, subagent: record });
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const subagentParameters = {
  action: z
    .string()
    .describe("Action to perform: spawn, status, list, result, or cancel."),
  task: z.string().optional().describe("Task for action=spawn."),
  title: z.string().optional().describe("Optional short display title for action=spawn."),
  subagent_id: z.string().optional().describe("Subagent id for status, result, or cancel."),
} as const;

async function getRecord(
  action: "status" | "result" | "cancel",
  subagentId: string,
  port: SubagentPort,
): Promise<string> {
  const record = action === "cancel" ? await port.cancel(subagentId) : await port[action](subagentId);
  if (!record) {
    return error(action, `Unknown subagent_id: ${subagentId}. Use action="list" to see subagents for this session.`);
  }
  return subagent(action, record);
}

export const subagentToolDefinition: AgentToolDefinition<typeof subagentParameters> = {
  name: "subagent",
  description:
    "Spawn and track asynchronous read-only subagent jobs. Subagents can inspect files with read, grep, find, ls, and skill, but cannot mutate files, run shell commands, ask the user, manage todos, or spawn subagents.",
  parameters: subagentParameters,
  authorize: (): null => {
    return null;
  },
  run: async (params, deps): Promise<string> => {
    const rawAction = typeof params.action === "string" ? params.action : "";
    const action = isSubagentAction(rawAction) ? rawAction : undefined;
    if (!action) {
      return error(rawAction || "unknown", `Parameter "action" must be one of: ${SUBAGENT_ACTIONS.join(", ")}.`);
    }

    try {
      if (action === "spawn") {
        const task = normalizeString(params.task);
        if (!task) return error(action, 'Parameter "task" is required for spawn.');
        const record = await deps.subagents.spawn({ task, title: normalizeString(params.title) });
        return subagent(action, record);
      }

      if (action === "list") {
        return json({ ok: true, action, subagents: await deps.subagents.list() });
      }

      const subagentId = normalizeString(params["subagent_id"]);
      if (!subagentId) return error(action, 'Parameter "subagent_id" is required for this action.');
      return await getRecord(action, subagentId, deps.subagents);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return error(action, message);
    }
  },
};

/** LM Studio tool that spawns and tracks read-only subagent jobs. */
export function createSubagentTool(port: SubagentPort): Tool {
  return toolFromDefinition(subagentToolDefinition, { subagents: port } as AgentToolDeps);
}
