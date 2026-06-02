import * as path from "@std/path";

import {
  type ApprovalGate,
  type ApprovalOperation,
  type ApprovalRequest,
  type ApprovalRisk,
  createDenyApprovalGate,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  requireApproval,
} from "../../shared/approval.ts";
import { expandTilde, WorkspaceSandbox } from "../workspace-sandbox.ts";

/** Workspace-scoped root for all tool I/O. */
export interface ToolContext {
  /** Absolute workspace directory; all tool paths must resolve inside this tree. */
  readonly root: string;
  /** Canonical workspace path resolver. */
  readonly sandbox: WorkspaceSandbox;
  /** Per-operation approval boundary for privileged tool side effects. */
  readonly approvalGate: ApprovalGate;
  /** Returns the current session id for approval requests. */
  readonly getSessionId: () => string;
  /** Returns the current turn id for approval requests. */
  readonly getTurnId: () => string;
  /** Abort signal for the active turn, when available. */
  readonly signal?: AbortSignal;
}

/** Options for creating a tool context. */
export interface ToolContextOptions {
  /** Approval gate used by privileged tool adapters. Defaults to deny. */
  approvalGate?: ApprovalGate;
  /** Session id or getter used in approval requests. */
  sessionId?: string | (() => string);
  /** Turn id or getter used in approval requests. */
  turnId?: string | (() => string);
  /** Abort signal for the active model turn. */
  signal?: AbortSignal;
  /** Pre-created sandbox, primarily for tests and shared runtime wiring. */
  sandbox?: WorkspaceSandbox;
}

/** Normalizes workspace root (no trailing separator). */
export function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  return resolved.endsWith(path.SEPARATOR) ? resolved.slice(0, -1) : resolved;
}

function valueGetter(value: string | (() => string) | undefined, fallback: string): () => string {
  if (typeof value === "function") return value;
  return () => value ?? fallback;
}

/** Creates context with a canonical workspace root (resolves symlinks such as /var to /private/var). */
export async function createToolContext(root: string, options: ToolContextOptions = {}): Promise<ToolContext> {
  const sandbox = options.sandbox ?? await WorkspaceSandbox.create(root);
  const context: ToolContext = {
    root: sandbox.root,
    sandbox,
    approvalGate: options.approvalGate ?? createDenyApprovalGate(),
    getSessionId: valueGetter(options.sessionId, "unknown-session"),
    getTurnId: valueGetter(options.turnId, "unknown-turn"),
  };
  if (options.signal !== undefined) {
    return { ...context, signal: options.signal };
  }
  return context;
}

/**
 * Resolves a user path to an absolute path under the workspace root.
 * @throws Error if the path escapes the workspace.
 */
export async function resolvePath(ctx: ToolContext, userPath: string): Promise<string> {
  return await ctx.sandbox.resolvePath(userPath);
}

/** Strips one layer of surrounding quotes from a user-supplied path. */
export function normalizeUserPath(userPath: string): string {
  const trimmed = userPath.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** True when the user path is resolved outside the workspace (absolute or `~`). */
export function isHostReadPath(userPath: string): boolean {
  const normalized = normalizeUserPath(userPath);
  return normalized.startsWith("~") || path.isAbsolute(expandTilde(normalized));
}

/** Resolves a path for `read`: workspace-relative paths stay sandboxed; host paths do not. */
export async function resolveReadPath(
  ctx: ToolContext,
  userPath: string,
): Promise<{ absolutePath: string; outsideWorkspace: boolean }> {
  const normalized = normalizeUserPath(userPath);
  // Host paths: expand only. Avoid Deno.realPath here — the permission broker would
  // prompt before the Telegram tool-approval step (resolveHostPath uses realPath).
  const absolutePath = isHostReadPath(normalized) ?
    path.resolve(expandTilde(normalized)) :
    await ctx.sandbox.resolvePath(normalized);
  return { absolutePath, outsideWorkspace: !ctx.sandbox.containsPath(absolutePath) };
}

/** @throws Error if path is not an existing directory under the workspace. */
export async function resolveDirectoryPath(ctx: ToolContext, userPath: string): Promise<string> {
  return await ctx.sandbox.resolveDirectoryPath(userPath || ".");
}

/** Converts an absolute path to a display path relative to workspace root when possible. */
export function displayPath(ctx: ToolContext, absolutePath: string): string {
  return ctx.sandbox.displayPath(absolutePath);
}

/** Requests approval for a tool operation. */
export async function approveToolOperation(
  ctx: ToolContext,
  spec: {
    operation: ApprovalOperation;
    target: string;
    risk: ApprovalRisk;
    summary?: string;
    timeoutMs?: number;
  },
): Promise<void> {
  const request: ApprovalRequest = {
    operation: spec.operation,
    target: spec.target,
    risk: spec.risk,
    sessionId: ctx.getSessionId(),
    turnId: ctx.getTurnId(),
    timeoutMs: spec.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
  };
  if (spec.summary !== undefined) request.summary = spec.summary;
  // Do not pass ctx.signal: it must not be the LM Studio act signal (abort cancels pending approvals).
  await requireApproval(ctx.approvalGate, request);
}
