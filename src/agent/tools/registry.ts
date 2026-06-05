import type { Tool } from "@lmstudio/sdk";

import { isMcpToolName, parseMcpToolName } from "../../mcp/naming.ts";
import type { ApprovalRequest } from "../../shared/approval.ts";
import { createDenyApprovalGate } from "../../shared/approval.ts";
import { logDebug } from "../../shared/log.ts";
import type { SubagentPort } from "../subagents.ts";
import { askUserQuestionToolDefinition } from "./ask-user-question.ts";
import type { GuardedToolCallRequest, ToolCallGuard, ToolCallGuardController } from "./authorization.ts";
import { bashToolDefinition } from "./bash.ts";
import { type AgentToolDefinition, type AgentToolDeps, parseToolParams, toolFromDefinition } from "./definitions.ts";
import { editToolDefinition } from "./edit.ts";
import { findToolDefinition } from "./find.ts";
import { grepToolDefinition } from "./grep.ts";
import { lsToolDefinition } from "./ls.ts";
import { readToolDefinition } from "./read.ts";
import { skillToolDefinition } from "./skill.ts";
import { subagentToolDefinition } from "./subagent.ts";
import { createNoopTodoDisplayPort } from "./todo-display-port.ts";
import { type TodoStore, todoWriteToolDefinition } from "./todo-write.ts";
import { typescriptReplToolDefinition } from "./typescript-repl.ts";
import { createUnavailableAskUserQuestionPort } from "./user-question-port.ts";
import { webFetchToolDefinition } from "./web-fetch.ts";
import { writeToolDefinition } from "./write.ts";
import { requestForOperation } from "./approval-support.ts";
import { createSkillManager } from "../skills/mod.ts";
import { createToolContext, type ToolContext } from "./context.ts";

export interface ModelToolSet {
  tools: Tool[];
  guardToolCall: ToolCallGuard;
  authorizeToolCall(call: GuardedToolCallRequest): Promise<ApprovalRequest | null>;
}

export const localToolDefinitions: readonly AgentToolDefinition[] = [
  readToolDefinition,
  writeToolDefinition,
  editToolDefinition,
  bashToolDefinition,
  typescriptReplToolDefinition,
  grepToolDefinition,
  findToolDefinition,
  lsToolDefinition,
  skillToolDefinition,
  todoWriteToolDefinition,
  webFetchToolDefinition,
  askUserQuestionToolDefinition,
  subagentToolDefinition,
];

export const readOnlySubagentToolDefinitions: readonly AgentToolDefinition[] = [
  readToolDefinition,
  grepToolDefinition,
  findToolDefinition,
  lsToolDefinition,
  skillToolDefinition,
];

const definitionByName = new Map(localToolDefinitions.map((definition) => [definition.name, definition]));

function unavailableSubagentPort(): SubagentPort {
  const unavailable = (): Promise<never> => Promise.reject(new Error("Subagent job service is not configured."));
  return {
    spawn: unavailable,
    status: unavailable,
    list: unavailable,
    result: unavailable,
    cancel: unavailable,
  };
}

function unavailableTodoStore(): TodoStore {
  const unavailable = (): Promise<never> => Promise.reject(new Error("Todo store is not configured."));
  return {
    read: unavailable,
    write: unavailable,
    updateTodos: unavailable,
    updateTelegramMeta: unavailable,
    copy: unavailable,
    label: (sessionId) => `workspace-kv:todos/${sessionId}`,
  };
}

function denialReason(reason: string): string {
  return `Tool call denied: ${reason}`;
}

function mcpApprovalRequest(deps: AgentToolDeps, name: string): ApprovalRequest {
  const parsed = parseMcpToolName(name);
  const target = parsed ? `${parsed.serverId}/${parsed.toolName}` : name;
  return requestForOperation(deps.workspace, {
    operation: "mcp",
    target,
    risk: "high",
    summary: "MCP remote tool call",
  });
}

async function resolveToolCallAuthorization(
  deps: AgentToolDeps,
  toolCallRequest: GuardedToolCallRequest,
): Promise<
  | { kind: "local"; request: ApprovalRequest | null; params: Record<string, unknown> }
  | { kind: "mcp"; request: ApprovalRequest }
> {
  const definition = definitionByName.get(toolCallRequest.name as AgentToolDefinition["name"]);
  if (definition) {
    const params = parseToolParams(definition, toolCallRequest.arguments);
    return {
      kind: "local",
      request: await definition.authorize(params, deps),
      params: { ...params },
    };
  }

  if (isMcpToolName(toolCallRequest.name)) {
    return { kind: "mcp", request: mcpApprovalRequest(deps, toolCallRequest.name) };
  }

  throw new Error(`No authorization policy for tool: ${toolCallRequest.name}`);
}

export async function authorizeToolCall(
  deps: AgentToolDeps,
  call: GuardedToolCallRequest,
): Promise<ApprovalRequest | null> {
  const resolved = await resolveToolCallAuthorization(deps, call);
  return resolved.request;
}

export function createToolCallGuard(deps: AgentToolDeps): ToolCallGuard {
  return async (_roundIndex, callId, controller: ToolCallGuardController) => {
    let resolved: Awaited<ReturnType<typeof resolveToolCallAuthorization>>;
    try {
      resolved = await resolveToolCallAuthorization(deps, controller.toolCallRequest);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logDebug("tool_guard.authorization_error", {
        tool: controller.toolCallRequest.name,
        callId: String(callId),
        message,
      });
      controller.deny(denialReason(message));
      return;
    }

    if (!resolved.request) {
      logDebug("tool_guard.auto_allowed", {
        tool: controller.toolCallRequest.name,
        callId: String(callId),
        sessionId: deps.workspace.getSessionId(),
        turnId: deps.workspace.getTurnId(),
      });
      controller.allowAndOverrideParameters(resolved.kind === "local" ? resolved.params : {});
      return;
    }

    let approved = false;
    let reason = "denied";
    try {
      const decision = await deps.approvalGate.requestApproval(resolved.request, deps.workspace.signal);
      approved = decision.approved;
      reason = decision.reason;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }

    if (approved) {
      logDebug("tool.approved", {
        operation: resolved.request.operation,
        risk: resolved.request.risk,
        sessionId: resolved.request.sessionId,
        turnId: resolved.request.turnId,
      });
      if (resolved.kind === "local") {
        controller.allowAndOverrideParameters(resolved.params);
      } else {
        controller.allow();
      }
      return;
    }

    controller.deny(denialReason(reason));
  };
}

export function getModelTools(deps: AgentToolDeps): Tool[] {
  const core = localToolDefinitions.map((definition) => toolFromDefinition(definition, deps));
  const mcp = deps.mcp?.getTools() ?? [];
  return [...core, ...mcp];
}

export function getModelToolSet(deps: AgentToolDeps): ModelToolSet {
  return {
    tools: getModelTools(deps),
    guardToolCall: createToolCallGuard(deps),
    authorizeToolCall: (call) => authorizeToolCall(deps, call),
  };
}

export function createReadOnlySubagentToolsFromDefinitions(
  workspace: ToolContext,
  skills: AgentToolDeps["skills"]["manager"],
): Tool[] {
  const deps = {
    workspace: {
      root: workspace.root,
      fs: workspace.fs.scoped({ allowHostPaths: false }),
      getSessionId: workspace.getSessionId,
      getTurnId: workspace.getTurnId,
      get signal() {
        return workspace.signal;
      },
    },
    approvalGate: createDenyApprovalGate("subagent_tools_are_not_interactive"),
    userQuestions: createUnavailableAskUserQuestionPort(),
    todos: {
      getSessionId: workspace.getSessionId,
      store: unavailableTodoStore(),
      display: createNoopTodoDisplayPort(),
    },
    skills: {
      manager: skills,
      getSessionId: workspace.getSessionId,
    },
    subagents: unavailableSubagentPort(),
  } satisfies AgentToolDeps;
  return readOnlySubagentToolDefinitions.map((definition) => toolFromDefinition(definition, deps));
}

/** Creates tools from a workspace directory path (canonicalizes root). */
export async function getModelToolsForRoot(root: string): Promise<Tool[]> {
  const workspace = await createToolContext(root);
  const skills = await createSkillManager({ root });
  return getModelTools({
    workspace,
    approvalGate: createDenyApprovalGate("approval_unavailable"),
    userQuestions: createUnavailableAskUserQuestionPort(),
    todos: {
      getSessionId: () => "00000000-0000-4000-8000-000000000000",
      store: unavailableTodoStore(),
      display: createNoopTodoDisplayPort(),
    },
    skills: {
      manager: skills,
      getSessionId: () => "00000000-0000-4000-8000-000000000000",
    },
    subagents: unavailableSubagentPort(),
  });
}
