import {
  type ApprovalOperation,
  type ApprovalRequest,
  type ApprovalRisk,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "../../shared/approval.ts";
import { displayPath, type ToolContext } from "./context.ts";

export function requestForOperation(
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

export function requestForHostAwareOperation(
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

export function parseHttpUrl(value: string): URL {
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

export function webFetchApprovalSummary(url: URL): string {
  return `GET ${url.pathname || "/"}`;
}

export async function todoFileDisplayPath(ctx: ToolContext, todosDir: string, sessionId: string): Promise<string> {
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

export async function canonicalDisplayPath(ctx: ToolContext, absolutePath: string): Promise<string> {
  try {
    return ctx.sandbox.displayPath(await Deno.realPath(absolutePath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return ctx.sandbox.displayPath(absolutePath);
    throw error;
  }
}

export function displayResolvedPath(ctx: ToolContext, absolutePath: string): string {
  return displayPath(ctx, absolutePath);
}
