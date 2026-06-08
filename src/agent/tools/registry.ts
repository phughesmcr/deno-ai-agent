import type { Tool } from "@lmstudio/sdk";

import { isMcpToolName, parseMcpToolName } from "../../mcp/naming.ts";
import type { CapabilityDecisionResult, CapabilityRequest } from "../../core/mod.ts";
import { ToolRuntime } from "../../core/tool_runtime.ts";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../../shared/approval.ts";
import { errorMessage } from "../../shared/error.ts";
import { logDebug } from "../../shared/log.ts";
import type { SubagentPort } from "../subagents.ts";
import { askUserQuestionToolDefinition } from "./ask-user-question.ts";
import type { GuardedToolCallRequest, ToolCallGuard, ToolCallGuardController } from "./authorization.ts";
import { bashToolDefinition } from "./bash.ts";
import {
  type AgentRuntimeToolDefinition,
  type AgentToolCapabilityRequestSpec,
  type AgentToolDefinition,
  type AgentToolDeps,
  runtimeToolFromDefinition,
  toolFromRuntimeDefinition,
} from "./definitions.ts";
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
import { createUnavailableUserInteractionPort } from "./user-question-port.ts";
import { webFetchToolDefinition } from "./web-fetch.ts";
import { writeToolDefinition } from "./write.ts";
import { createSkillManager } from "../skills/mod.ts";
import { createToolContext, type ToolContext } from "./context.ts";

export interface ModelToolSet {
  tools: Tool[];
  guardToolCall: ToolCallGuard;
  authorizeToolCall(call: GuardedToolCallRequest): Promise<CapabilityRequest | null>;
}

/** Per-turn capability authorizer used by guarded model tool calls. */
export interface ToolCapabilityAuthorizer {
  decide(request: CapabilityRequest, signal?: AbortSignal): Promise<CapabilityDecisionResult>;
}

/** Optional controls for deterministic authorization tests. */
export interface TurnAuthorizationOptions {
  createRequestId?: () => string;
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

const localRuntimeTools = localToolDefinitions.map(runtimeToolFromDefinition);
const readOnlySubagentRuntimeTools = readOnlySubagentToolDefinitions.map(runtimeToolFromDefinition);

function toolName(tool: Tool): string | undefined {
  const name = (tool as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function mcpRuntimeTool(name: string): AgentRuntimeToolDefinition {
  return {
    name,
    describe(): ReturnType<AgentRuntimeToolDefinition["describe"]> {
      return {
        name,
        description: "MCP remote tool",
        parameters: {},
      };
    },
    parse(raw: Record<string, unknown> | undefined): Record<string, unknown> {
      return raw ?? {};
    },
    authorize(): AgentToolCapabilityRequestSpec {
      return mcpCapabilityRequestSpec(name);
    },
    execute(): string {
      throw new Error("MCP tools execute through the MCP registry adapter.");
    },
  };
}

function exposedMcpRuntimeTools(deps: AgentToolDeps): AgentRuntimeToolDefinition[] {
  return (deps.mcp?.getTools() ?? [])
    .map(toolName)
    .filter((name): name is string => name !== undefined && isMcpToolName(name))
    .map(mcpRuntimeTool);
}

function toolRuntimeForDeps(deps: AgentToolDeps): ToolRuntime<AgentToolDeps, AgentToolCapabilityRequestSpec, string> {
  return new ToolRuntime<AgentToolDeps, AgentToolCapabilityRequestSpec, string>([
    ...localRuntimeTools,
    ...exposedMcpRuntimeTools(deps),
  ]);
}

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

function mcpCapabilityRequestSpec(name: string): AgentToolCapabilityRequestSpec {
  const parsed = parseMcpToolName(name);
  const target = parsed ? `${parsed.serverId}/${parsed.toolName}` : name;
  return {
    source: "mcp_tool",
    capability: { kind: "mcp_tool", target, action: "call" },
    risk: "high",
    summary: "MCP remote tool call",
    timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
    display: {
      action: "call",
      target,
      subject: name,
    },
  };
}

async function resolveToolCallAuthorization(
  deps: AgentToolDeps,
  toolCallRequest: GuardedToolCallRequest,
  createRequestId: () => string,
): Promise<
  | { kind: "local"; request: CapabilityRequest | null; params: Record<string, unknown> }
  | { kind: "mcp"; request: CapabilityRequest }
> {
  const definition = toolRuntimeForDeps(deps).get(toolCallRequest.name);
  if (definition) {
    const params = definition.parse(toolCallRequest.arguments);
    const spec = await definition.authorize(params, deps);
    const request = spec ?
      {
        id: createRequestId(),
        sessionId: deps.workspace.getSessionId(),
        workId: deps.workspace.getTurnId(),
        ...spec,
      } satisfies CapabilityRequest :
      null;
    if (isMcpToolName(toolCallRequest.name)) {
      if (!request) throw new Error(`MCP tool did not produce an authorization request: ${toolCallRequest.name}`);
      return { kind: "mcp", request };
    }
    return { kind: "local", request, params: { ...(params as Record<string, unknown>) } };
  }

  throw new Error(`No authorization policy for tool: ${toolCallRequest.name}`);
}

export async function authorizeToolCall(
  deps: AgentToolDeps,
  call: GuardedToolCallRequest,
  options: TurnAuthorizationOptions = {},
): Promise<CapabilityRequest | null> {
  const resolved = await resolveToolCallAuthorization(
    deps,
    call,
    options.createRequestId ?? (() => crypto.randomUUID()),
  );
  return resolved.request;
}

export function createToolCallGuard(
  deps: AgentToolDeps,
  authorizer: ToolCapabilityAuthorizer,
  options: TurnAuthorizationOptions = {},
): ToolCallGuard {
  const createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  return async (_roundIndex, callId, controller: ToolCallGuardController) => {
    let resolved: Awaited<ReturnType<typeof resolveToolCallAuthorization>>;
    try {
      resolved = await resolveToolCallAuthorization(deps, controller.toolCallRequest, createRequestId);
    } catch (error) {
      const message = errorMessage(error);
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
      const decision = await authorizer.decide(resolved.request, deps.workspace.signal);
      approved = decision.allowed;
      reason = decision.reason;
    } catch (error) {
      reason = errorMessage(error);
    }

    if (approved) {
      logDebug("tool.approved", {
        operation: resolved.request.capability.action,
        risk: resolved.request.risk,
        sessionId: resolved.request.sessionId,
        turnId: resolved.request.workId ?? "",
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

/** Per-turn facade for model tools and capability guard authorization. */
export class TurnAuthorization {
  private readonly _deps: AgentToolDeps;
  private readonly _authorizer: ToolCapabilityAuthorizer;
  private readonly _options: TurnAuthorizationOptions;

  /** Creates a per-turn authorization facade. */
  constructor(
    deps: AgentToolDeps,
    authorizer: ToolCapabilityAuthorizer,
    options: TurnAuthorizationOptions = {},
  ) {
    this._deps = deps;
    this._authorizer = authorizer;
    this._options = options;
  }

  /** Returns model-facing tools for the turn. */
  getModelTools(): Tool[] {
    return getModelTools(this._deps);
  }

  /** Parses and maps a tool call to a capability request without deciding it. */
  authorizeToolCall(call: GuardedToolCallRequest): Promise<CapabilityRequest | null> {
    return authorizeToolCall(this._deps, call, this._options);
  }

  /** Creates the LM Studio tool-call guard for this turn. */
  createGuardToolCall(): ToolCallGuard {
    return createToolCallGuard(this._deps, this._authorizer, this._options);
  }

  /** Returns tools plus guard as a single model turn set. */
  getModelToolSet(): ModelToolSet {
    return {
      tools: this.getModelTools(),
      guardToolCall: this.createGuardToolCall(),
      authorizeToolCall: (call) => this.authorizeToolCall(call),
    };
  }
}

export function getModelTools(deps: AgentToolDeps): Tool[] {
  const core = localRuntimeTools.map((definition) => toolFromRuntimeDefinition(definition, deps));
  const mcp = deps.mcp?.getTools() ?? [];
  return [...core, ...mcp];
}

export function getModelToolSet(
  deps: AgentToolDeps,
  authorizer: ToolCapabilityAuthorizer,
  options: TurnAuthorizationOptions = {},
): ModelToolSet {
  return new TurnAuthorization(deps, authorizer, options).getModelToolSet();
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
    userQuestions: createUnavailableUserInteractionPort(),
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
  return readOnlySubagentRuntimeTools.map((definition) => toolFromRuntimeDefinition(definition, deps));
}

/** Creates tools from a workspace directory path (canonicalizes root). */
export async function getModelToolsForRoot(root: string): Promise<Tool[]> {
  const workspace = await createToolContext(root);
  const skills = await createSkillManager({ root });
  return getModelTools({
    workspace,
    userQuestions: createUnavailableUserInteractionPort(),
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
