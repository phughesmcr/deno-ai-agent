import {
  type ApprovalOperation,
  type ApprovalRequest,
  type ApprovalRisk,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "../../shared/approval.ts";
import type { ToolContext } from "./context.ts";

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

export function todoKvDisplayPath(sessionId: string): string {
  return `workspace-kv:todos/${sessionId}`;
}

export async function canonicalDisplayPath(ctx: ToolContext, absolutePath: string): Promise<string> {
  try {
    return ctx.fs.displayPath(await Deno.realPath(absolutePath));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return ctx.fs.displayPath(absolutePath);
    throw error;
  }
}

export function displayResolvedPath(ctx: ToolContext, absolutePath: string): string {
  return ctx.fs.displayPath(absolutePath);
}
