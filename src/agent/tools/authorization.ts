import {
  type ApprovalGate,
  type ApprovalOperation,
  type ApprovalRequest,
  type ApprovalRisk,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "../../shared/approval.ts";
import { logDebug } from "../../shared/log.ts";
import type { SkillManager } from "../skills/mod.ts";
import { displayPath, resolveHostAwarePath, resolveReadPath, type ToolContext } from "./context.ts";
import type { TodoItem } from "./todo-write.ts";

const TYPESCRIPT_REPL_DEFAULT_TIMEOUT_SECONDS = 5;

/** Model tool-call request shape used by LM Studio's guard hook. */
export interface GuardedToolCallRequest {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** Small structural subset of LM Studio's non-exported guard controller. */
export interface ToolCallGuardController {
  readonly toolCallRequest: GuardedToolCallRequest;
  allow(): void;
  deny(reason?: string): void;
  allowAndOverrideParameters(newParameters: Record<string, unknown>): void;
}

/** App-level guard function passed to `model.act()`. */
export type ToolCallGuard = (
  roundIndex: number,
  callId: number,
  controller: ToolCallGuardController,
) => void | Promise<void>;

/** Dependencies for central model tool authorization. */
export interface ToolAuthorizationDeps {
  workspace: ToolContext;
  approvalGate: ApprovalGate;
  todos: {
    getSessionId: () => string;
    todosDir: string;
  };
  skills: {
    manager: SkillManager;
  };
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new Error(`Parameter "${key}" must be a string.`);
  return value;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Parameter "${key}" must be a number.`);
  }
  return value;
}

function requestForOperation(
  ctx: ToolContext,
  spec: {
    operation: ApprovalOperation;
    target: string;
    risk: ApprovalRisk;
    summary?: string;
    timeoutMs?: number;
  },
): ApprovalRequest {
  const request: ApprovalRequest = {
    operation: spec.operation,
    target: spec.target,
    risk: spec.risk,
    sessionId: ctx.getSessionId(),
    turnId: ctx.getTurnId(),
    timeoutMs: spec.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
  };
  if (spec.summary !== undefined) request.summary = spec.summary;
  return request;
}

function requestForHostAwareOperation(
  ctx: ToolContext,
  spec: {
    operation: ApprovalOperation;
    absolutePath: string;
    outsideWorkspace: boolean;
    display: string;
    workspaceRisk?: ApprovalRisk;
    summary?: string;
  },
): ApprovalRequest {
  return requestForOperation(ctx, {
    operation: spec.operation,
    target: spec.outsideWorkspace ? spec.absolutePath : spec.display,
    risk: spec.outsideWorkspace ? "high" : spec.workspaceRisk ?? "low",
    summary: spec.summary,
    timeoutMs: spec.outsideWorkspace ? DEFAULT_APPROVAL_TIMEOUT_MS * 2 : undefined,
  });
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web-fetch only accepts http: and https: URLs.");
  }
  if (url.username || url.password) {
    throw new Error("web-fetch does not accept URLs with credentials.");
  }
  return url;
}

function webFetchApprovalSummary(url: URL): string {
  return `GET ${url.pathname || "/"}`;
}

function todosCount(value: unknown): number {
  if (!Array.isArray(value)) throw new Error('Parameter "todos" must be an array.');
  return (value as TodoItem[]).length;
}

async function todoFileDisplayPath(ctx: ToolContext, todosDir: string, sessionId: string): Promise<string> {
  try {
    const canonicalTodosDir = await Deno.realPath(todosDir);
    return ctx.sandbox.displayPath(`${canonicalTodosDir}/${sessionId}.json`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return ctx.sandbox.displayPath(`${todosDir}/${sessionId}.json`);
    }
    throw error;
  }
}

async function canonicalDisplayPath(ctx: ToolContext, absolutePath: string): Promise<string> {
  try {
    return ctx.sandbox.displayPath(await Deno.realPath(absolutePath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return ctx.sandbox.displayPath(absolutePath);
    throw error;
  }
}

/** Resolves a model tool call into an app approval request, or null for auto-allowed tools. */
export async function approvalRequestForToolCall(
  deps: ToolAuthorizationDeps,
  toolCallRequest: GuardedToolCallRequest,
): Promise<ApprovalRequest | null> {
  const ctx = deps.workspace;
  const params = toolCallRequest.arguments ?? {};

  switch (toolCallRequest.name) {
    case "read": {
      const userPath = requireString(params, "path");
      const offset = optionalNumber(params, "offset");
      const limit = optionalNumber(params, "limit");
      const { absolutePath, outsideWorkspace } = await resolveReadPath(ctx, userPath);
      const rangeSummary = offset || limit ?
        `read text with offset=${offset ?? 1}, limit=${limit ?? "default"}` :
        "read text";
      return requestForHostAwareOperation(ctx, {
        operation: "read",
        absolutePath,
        outsideWorkspace,
        display: displayPath(ctx, absolutePath),
        summary: outsideWorkspace ? `host ${rangeSummary}` : rangeSummary,
      });
    }

    case "write": {
      const userPath = requireString(params, "path");
      const content = requireString(params, "content");
      const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
      return requestForHostAwareOperation(ctx, {
        operation: "write",
        absolutePath,
        outsideWorkspace,
        display: displayPath(ctx, absolutePath),
        workspaceRisk: "medium",
        summary: `write ${content.length} bytes`,
      });
    }

    case "edit": {
      const userPath = requireString(params, "path");
      const edits = params["edits"];
      if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('Parameter "edits" must be a non-empty array.');
      }
      const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
      return requestForHostAwareOperation(ctx, {
        operation: "edit",
        absolutePath,
        outsideWorkspace,
        display: displayPath(ctx, absolutePath),
        workspaceRisk: "medium",
        summary: `replace ${edits.length} block(s)`,
      });
    }

    case "ls": {
      const userPath = typeof params["path"] === "string" ? params["path"] : ".";
      const limit = optionalNumber(params, "limit") ?? 500;
      const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
      return requestForHostAwareOperation(ctx, {
        operation: "list",
        absolutePath,
        outsideWorkspace,
        display: displayPath(ctx, absolutePath),
        summary: `list directory, limit=${limit}`,
      });
    }

    case "find": {
      const userPath = typeof params["path"] === "string" ? params["path"] : ".";
      const limit = optionalNumber(params, "limit") ?? 1000;
      const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
      return requestForHostAwareOperation(ctx, {
        operation: "find",
        absolutePath,
        outsideWorkspace,
        display: displayPath(ctx, absolutePath),
        summary: `find files, limit=${limit}`,
      });
    }

    case "grep": {
      const userPath = typeof params["path"] === "string" ? params["path"] : ".";
      const limit = Math.max(1, optionalNumber(params, "limit") ?? 100);
      const context = optionalNumber(params, "context") ?? 0;
      const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
      return requestForHostAwareOperation(ctx, {
        operation: "grep",
        absolutePath,
        outsideWorkspace,
        display: displayPath(ctx, absolutePath),
        summary: `search text, limit=${limit}, context=${context}`,
      });
    }

    case "bash": {
      const command = requireString(params, "command");
      return requestForOperation(ctx, {
        operation: "shell",
        target: command,
        risk: "high",
        summary: `cwd=${ctx.root}`,
      });
    }

    case "typescript-repl": {
      const typescript = requireString(params, "typescript");
      const timeout = optionalNumber(params, "timeout") ?? TYPESCRIPT_REPL_DEFAULT_TIMEOUT_SECONDS;
      return requestForOperation(ctx, {
        operation: "shell",
        target: "typescript-repl",
        risk: "high",
        summary: `run typescript, timeout=${timeout}s, ${typescript.length} bytes`,
      });
    }

    case "web-fetch": {
      const url = parseHttpUrl(requireString(params, "url"));
      return requestForOperation(ctx, {
        operation: "network",
        target: url.origin,
        risk: "high",
        summary: webFetchApprovalSummary(url),
      });
    }

    case "todo_write": {
      const sessionId = deps.todos.getSessionId();
      return requestForOperation(ctx, {
        operation: "todo",
        target: await todoFileDisplayPath(ctx, deps.todos.todosDir, sessionId),
        risk: "medium",
        summary: `write ${todosCount(params["todos"])} todo item(s)`,
      });
    }

    case "skill": {
      const name = requireString(params, "skill");
      const skill = deps.skills.manager.get(name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      return requestForOperation(ctx, {
        operation: "skill",
        target: await canonicalDisplayPath(ctx, skill.filePath),
        risk: "low",
        summary: `activate skill ${skill.name}`,
      });
    }

    case "ask_user_question":
    case "subagent":
      return null;

    default:
      throw new Error(`No authorization policy for tool: ${toolCallRequest.name}`);
  }
}

function denialReason(reason: string): string {
  return `Tool call denied: ${reason}`;
}

/** Creates the central LM Studio guard that owns app-layer Telegram approvals. */
export function createToolCallGuard(deps: ToolAuthorizationDeps): ToolCallGuard {
  return async (_roundIndex, callId, controller) => {
    let request: ApprovalRequest | null;
    try {
      request = await approvalRequestForToolCall(deps, controller.toolCallRequest);
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

    if (!request) {
      logDebug("tool_guard.auto_allowed", {
        tool: controller.toolCallRequest.name,
        callId: String(callId),
        sessionId: deps.workspace.getSessionId(),
        turnId: deps.workspace.getTurnId(),
      });
      controller.allow();
      return;
    }

    let approved = false;
    let reason = "denied";
    try {
      const decision = await deps.approvalGate.requestApproval(request);
      approved = decision.approved;
      reason = decision.reason;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }

    if (approved) {
      logDebug("tool.approved", {
        operation: request.operation,
        risk: request.risk,
        sessionId: request.sessionId,
        turnId: request.turnId,
      });
      controller.allow();
      return;
    }

    controller.deny(denialReason(reason));
  };
}
