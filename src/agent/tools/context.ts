import * as path from "@std/path";

import {
  grantBrokerReadPath,
  grantBrokerWritePath,
  shouldRunPermissionControlClient,
} from "../../permission-broker/mod.ts";
import { logDebug } from "../../shared/log.ts";
import { expandTilde, WorkspaceSandbox } from "../workspace-sandbox.ts";

/** Workspace-scoped root for all tool I/O. */
export interface ToolContext {
  /** Absolute workspace directory; all tool paths must resolve inside this tree. */
  readonly root: string;
  /** Canonical workspace path resolver. */
  readonly sandbox: WorkspaceSandbox;
  /** Returns the current session id for approval requests. */
  readonly getSessionId: () => string;
  /** Returns the current turn id for approval requests. */
  readonly getTurnId: () => string;
  /** Abort signal for the active turn, when available. */
  readonly signal?: AbortSignal;
  /** Whether tools may resolve absolute or ~/ host paths outside the workspace. */
  readonly allowHostPaths: boolean;
}

/** Options for creating a tool context. */
export interface ToolContextOptions {
  /** Session id or getter used in approval requests. */
  sessionId?: string | (() => string);
  /** Turn id or getter used in approval requests. */
  turnId?: string | (() => string);
  /** Abort signal, or getter for the active model turn signal. */
  signal?: AbortSignal | (() => AbortSignal | undefined);
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

function signalGetter(value: ToolContextOptions["signal"]): () => AbortSignal | undefined {
  if (typeof value === "function") return value;
  return () => value;
}

/** Creates context with a canonical workspace root (resolves symlinks such as /var to /private/var). */
export async function createToolContext(root: string, options: ToolContextOptions = {}): Promise<ToolContext> {
  const sandbox = options.sandbox ?? await WorkspaceSandbox.create(root);
  const getSignal = signalGetter(options.signal);
  const context: ToolContext = {
    root: sandbox.root,
    sandbox,
    getSessionId: valueGetter(options.sessionId, "unknown-session"),
    getTurnId: valueGetter(options.turnId, "unknown-turn"),
    allowHostPaths: true,
    get signal() {
      return getSignal();
    },
  };
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
export function isHostPath(userPath: string): boolean {
  const normalized = normalizeUserPath(userPath);
  return normalized.startsWith("~") || path.isAbsolute(expandTilde(normalized));
}

/** Resolved tool path, workspace-sandboxed or host-absolute. */
export interface HostAwarePath {
  absolutePath: string;
  outsideWorkspace: boolean;
}

/**
 * Resolves a tool path: workspace-relative paths stay sandboxed; host paths do not.
 * Avoids filesystem canonicalization on host paths so broker prompts stay after Telegram approval.
 */
export async function resolveHostAwarePath(ctx: ToolContext, userPath: string): Promise<HostAwarePath> {
  const normalized = normalizeUserPath(userPath);
  const expanded = expandTilde(normalized);
  if (path.isAbsolute(expanded) && ctx.sandbox.containsPath(path.resolve(expanded))) {
    return { absolutePath: await ctx.sandbox.resolvePath(expanded), outsideWorkspace: false };
  }
  if (isHostPath(normalized) && !ctx.allowHostPaths) {
    throw new Error("Host paths are not available in this tool context. Use workspace-relative paths.");
  }
  const absolutePath = isHostPath(normalized) ? path.resolve(expanded) : await ctx.sandbox.resolvePath(normalized);
  return { absolutePath, outsideWorkspace: !ctx.sandbox.containsPath(absolutePath) };
}

/** Returns a view of a tool context that rejects host paths outside the workspace. */
export function workspaceOnlyToolContext(ctx: ToolContext): ToolContext {
  return {
    root: ctx.root,
    sandbox: ctx.sandbox,
    getSessionId: ctx.getSessionId,
    getTurnId: ctx.getTurnId,
    allowHostPaths: false,
    get signal() {
      return ctx.signal;
    },
  };
}

/** Resolves a path for `read`: workspace-relative paths stay sandboxed; host paths do not. */
export async function resolveReadPath(ctx: ToolContext, userPath: string): Promise<HostAwarePath> {
  return await resolveHostAwarePath(ctx, userPath);
}

/** Pre-grants broker read for a host path when the permission broker is active. */
export async function grantBrokerHostRead(absolutePath: string, signal?: AbortSignal): Promise<void> {
  if (shouldRunPermissionControlClient()) {
    logDebug("broker_grant.start", { permission: "read", value: absolutePath });
    await grantBrokerReadPath(absolutePath, signal);
    logDebug("broker_grant.completed", { permission: "read", value: absolutePath });
  }
}

/** Pre-grants broker write for a host path when the permission broker is active. */
export async function grantBrokerHostWrite(absolutePath: string, signal?: AbortSignal): Promise<void> {
  if (shouldRunPermissionControlClient()) {
    logDebug("broker_grant.start", { permission: "write", value: absolutePath });
    await grantBrokerWritePath(absolutePath, signal);
    logDebug("broker_grant.completed", { permission: "write", value: absolutePath });
  }
}

/** Pre-grants broker read and write for a host path when the permission broker is active. */
export async function grantBrokerHostReadWrite(absolutePath: string, signal?: AbortSignal): Promise<void> {
  await grantBrokerHostRead(absolutePath, signal);
  await grantBrokerHostWrite(absolutePath, signal);
}

/** @throws Error if path is not an existing directory under the workspace. */
export async function resolveDirectoryPath(ctx: ToolContext, userPath: string): Promise<string> {
  return await ctx.sandbox.resolveDirectoryPath(userPath || ".");
}

/** Converts an absolute path to a display path relative to workspace root when possible. */
export function displayPath(ctx: ToolContext, absolutePath: string): string {
  return ctx.sandbox.displayPath(absolutePath);
}
