import * as path from "@std/path";

import { WorkspaceSandbox } from "../workspace-sandbox.ts";
import { createToolFilesystem, type ToolFilesystem } from "./tool-filesystem.ts";

/** Workspace-scoped root for all tool I/O. */
export interface ToolContext {
  /** Absolute workspace directory; all tool paths must resolve inside this tree. */
  readonly root: string;
  /** Filesystem access policy and broker grant coordinator. */
  readonly fs: ToolFilesystem;
  /** Returns the current session id for approval requests. */
  readonly getSessionId: () => string;
  /** Returns the current turn id for approval requests. */
  readonly getTurnId: () => string;
  /** Abort signal for the active turn, when available. */
  readonly signal?: AbortSignal;
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
  const getSessionId = valueGetter(options.sessionId, "unknown-session");
  const getTurnId = valueGetter(options.turnId, "unknown-turn");
  const getSignal = signalGetter(options.signal);
  const fs = await createToolFilesystem(sandbox.root, {
    sandbox,
    sessionId: getSessionId,
    turnId: getTurnId,
    signal: getSignal,
  });
  const context: ToolContext = {
    root: sandbox.root,
    fs,
    getSessionId,
    getTurnId,
    get signal() {
      return getSignal();
    },
  };
  return context;
}
