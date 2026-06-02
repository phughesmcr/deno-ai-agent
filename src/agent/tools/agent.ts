import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import type { SubagentPort, SubagentRecord } from "../subagents.ts";

/** Supported model-facing actions for the `agent` tool. */
export type AgentAction = "spawn" | "status" | "list" | "result" | "cancel";

const AGENT_ACTION_VALUES = ["spawn", "status", "list", "result", "cancel"] as const;
const AGENT_ACTIONS: readonly AgentAction[] = AGENT_ACTION_VALUES;

/** Parameters accepted by the `agent` tool. */
export interface AgentToolParams {
  /** Action to perform. */
  action: AgentAction;
  /** Required task prompt for `spawn`. */
  task?: string;
  /** Optional short title for `spawn`. */
  title?: string;
  /** Required subagent id for `status`, `result`, and `cancel`. */
  ["agent_id"]?: string;
}

/** Stable JSON response shape returned by the `agent` tool. */
export type AgentToolResponse =
  | { ok: true; action: AgentAction; agent: SubagentRecord }
  | { ok: true; action: "list"; agents: SubagentRecord[] }
  | { ok: false; action: AgentAction | string; error: string };

type AgentToolInput = {
  action?: string;
  task?: string;
  title?: string;
  ["agent_id"]?: string;
};

function isAgentAction(value: string): value is AgentAction {
  return AGENT_ACTIONS.includes(value as AgentAction);
}

function json(response: AgentToolResponse): string {
  return JSON.stringify(response);
}

function error(action: AgentAction | string, message: string): string {
  return json({ ok: false, action, error: message });
}

function agent(action: AgentAction, record: SubagentRecord): string {
  return json({ ok: true, action, agent: record });
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function getRecord(
  action: "status" | "result" | "cancel",
  agentId: string,
  port: SubagentPort,
): Promise<string> {
  const record = action === "cancel" ? await port.cancel(agentId) : await port[action](agentId);
  if (!record) {
    return error(action, `Unknown agent_id: ${agentId}. Use action="list" to see subagents for this session.`);
  }
  return agent(action, record);
}

/** LM Studio tool that spawns and tracks read-only subagent jobs. */
export function createAgentTool(port: SubagentPort): unknown {
  return tool({
    name: "agent",
    description:
      "Spawn and track asynchronous read-only subagent jobs. Subagents can inspect files with read, grep, find, ls, and skill, but cannot mutate files, run shell commands, ask the user, manage todos, or spawn agents.",
    parameters: {
      action: z
        .string()
        .describe("Action to perform: spawn, status, list, result, or cancel."),
      task: z.string().optional().describe("Task for action=spawn."),
      title: z.string().optional().describe("Optional short display title for action=spawn."),
      agent_id: z.string().optional().describe("Subagent id for status, result, or cancel."),
    },
    implementation: async (params: AgentToolInput) => {
      const rawAction = typeof params.action === "string" ? params.action : "";
      const action = isAgentAction(rawAction) ? rawAction : undefined;
      if (!action) {
        return error(rawAction || "unknown", `Parameter "action" must be one of: ${AGENT_ACTIONS.join(", ")}.`);
      }

      try {
        if (action === "spawn") {
          const task = normalizeString(params.task);
          if (!task) return error(action, 'Parameter "task" is required for spawn.');
          const record = await port.spawn({ task, title: normalizeString(params.title) });
          return agent(action, record);
        }

        if (action === "list") {
          return json({ ok: true, action, agents: await port.list() });
        }

        const agentId = normalizeString(params["agent_id"]);
        if (!agentId) return error(action, 'Parameter "agent_id" is required for this action.');
        return await getRecord(action, agentId, port);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return error(action, message);
      }
    },
  });
}
