import * as path from "@std/path";

import {
  grantBrokerReadPath,
  grantBrokerRunForCommands,
  grantBrokerWritePath,
  shouldRunPermissionControlClient,
} from "../../permission-broker/mod.ts";
import { type ApprovalOperation, type ApprovalRisk, DEFAULT_APPROVAL_TIMEOUT_MS } from "../../shared/approval.ts";
import { logDebug } from "../../shared/log.ts";
import { expandTilde, WorkspaceSandbox } from "../workspace-sandbox.ts";
import type { AgentToolCapabilityRequestSpec } from "./definitions.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";

export interface ToolFilesystem {
  readonly root: string;
  readonly signal?: AbortSignal;
  operation(spec: ToolFilesystemOperationSpec): Promise<ToolFilesystemOperation>;
  scoped(options: { allowHostPaths: boolean }): ToolFilesystem;
  displayPath(absolutePath: string): string;
}

export interface ToolFilesystemOperationSpec {
  readonly operation: ApprovalOperation;
  readonly path?: string;
  readonly access: "read" | "write" | "readWrite";
  readonly require?: "path" | "existingFile" | "existingDirectory" | "existingFileOrDirectory" | "missing";
  readonly workspaceRisk?: ApprovalRisk;
  readonly summary: string;
  readonly externalCommands?: readonly string[];
  readonly mutationQueue?: boolean;
}

export interface ToolFilesystemOperation {
  readonly target: ToolFilesystemTarget;
  capabilityRequest(): AgentToolCapabilityRequestSpec;
  withAccess<T>(callback: (target: ToolFilesystemTarget) => Promise<T>): Promise<T>;
}

export interface ToolFilesystemTarget {
  readonly inputPath: string;
  readonly absolutePath: string;
  readonly displayPath: string;
  readonly outsideWorkspace: boolean;
  readonly kind: "file" | "directory" | "other" | "missing";
  readonly signal?: AbortSignal;
}

export interface ToolFilesystemOptions {
  readonly sessionId?: string | (() => string);
  readonly turnId?: string | (() => string);
  readonly signal?: AbortSignal | (() => AbortSignal | undefined);
  readonly sandbox?: WorkspaceSandbox;
  readonly allowHostPaths?: boolean;
}

function valueGetter(value: string | (() => string) | undefined, fallback: string): () => string {
  if (typeof value === "function") return value;
  return () => value ?? fallback;
}

function signalGetter(value: ToolFilesystemOptions["signal"]): () => AbortSignal | undefined {
  if (typeof value === "function") return value;
  return () => value;
}

/** Strips one layer of surrounding quotes from a user-supplied path. */
function normalizeUserPath(userPath: string): string {
  const trimmed = userPath.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isHostPath(userPath: string): boolean {
  const normalized = normalizeUserPath(userPath);
  return normalized.startsWith("~") || path.isAbsolute(expandTilde(normalized));
}

async function pathKind(absolutePath: string): Promise<ToolFilesystemTarget["kind"]> {
  try {
    const stat = await Deno.stat(absolutePath);
    if (stat.isFile) return "file";
    if (stat.isDirectory) return "directory";
    return "other";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "missing";
    throw error;
  }
}

function assertRequiredKind(target: ToolFilesystemTarget, required: ToolFilesystemOperationSpec["require"]): void {
  if (!required || required === "path") return;
  if (required === "existingFile" && target.kind !== "file") {
    throw new Error(`Not a file: ${target.displayPath}`);
  }
  if (required === "existingDirectory" && target.kind !== "directory") {
    throw new Error(`Not a directory: ${target.displayPath}`);
  }
  if (
    required === "existingFileOrDirectory" &&
    target.kind !== "file" &&
    target.kind !== "directory"
  ) {
    throw new Error(`Not a file or directory: ${target.displayPath}`);
  }
  if (required === "missing" && target.kind !== "missing") {
    throw new Error(`Path already exists: ${target.displayPath}`);
  }
}

async function grantBrokerHostRead(absolutePath: string, signal?: AbortSignal): Promise<void> {
  if (shouldRunPermissionControlClient()) {
    logDebug("broker_grant.start", { permission: "read", value: absolutePath });
    await grantBrokerReadPath(absolutePath, signal);
    logDebug("broker_grant.completed", { permission: "read", value: absolutePath });
  }
}

async function grantBrokerHostWrite(absolutePath: string, signal?: AbortSignal): Promise<void> {
  if (shouldRunPermissionControlClient()) {
    logDebug("broker_grant.start", { permission: "write", value: absolutePath });
    await grantBrokerWritePath(absolutePath, signal);
    logDebug("broker_grant.completed", { permission: "write", value: absolutePath });
  }
}

async function grantBrokerAccess(
  target: ToolFilesystemTarget,
  access: ToolFilesystemOperationSpec["access"],
): Promise<void> {
  if (!target.outsideWorkspace) return;
  if (access === "read" || access === "readWrite") {
    await grantBrokerHostRead(target.absolutePath, target.signal);
  }
  if (access === "write" || access === "readWrite") {
    await grantBrokerHostWrite(target.absolutePath, target.signal);
  }
}

class ToolFilesystemOperationImpl implements ToolFilesystemOperation {
  readonly target: ToolFilesystemTarget;
  private readonly _spec: ToolFilesystemOperationSpec;

  constructor(
    target: ToolFilesystemTarget,
    spec: ToolFilesystemOperationSpec,
  ) {
    this.target = target;
    this._spec = spec;
  }

  capabilityRequest(): AgentToolCapabilityRequestSpec {
    const target = this.target.outsideWorkspace ? this.target.absolutePath : this.target.displayPath;
    return {
      source: "local_tool",
      capability: {
        kind: "local_tool",
        target,
        action: this._spec.operation,
      },
      risk: this.target.outsideWorkspace ? "high" : this._spec.workspaceRisk ?? "low",
      summary: this._spec.summary,
      timeoutMs: this.target.outsideWorkspace ? DEFAULT_APPROVAL_TIMEOUT_MS * 2 : DEFAULT_APPROVAL_TIMEOUT_MS,
      display: {
        action: this._spec.operation,
        target,
      },
    };
  }

  async withAccess<T>(callback: (target: ToolFilesystemTarget) => Promise<T>): Promise<T> {
    this.target.signal?.throwIfAborted();
    await grantBrokerAccess(this.target, this._spec.access);
    if (this._spec.externalCommands?.length) {
      await grantBrokerRunForCommands(this._spec.externalCommands, this.target.signal);
    }
    this.target.signal?.throwIfAborted();

    if (this._spec.mutationQueue) {
      return await withFileMutationQueue(this.target.absolutePath, () => callback(this.target));
    }
    return await callback(this.target);
  }
}

class ToolFilesystemImpl implements ToolFilesystem {
  private readonly _sandbox: WorkspaceSandbox;
  private readonly _allowHostPaths: boolean;
  private readonly _getSessionId: () => string;
  private readonly _getTurnId: () => string;
  private readonly _getSignal: () => AbortSignal | undefined;

  constructor(options: {
    sandbox: WorkspaceSandbox;
    allowHostPaths: boolean;
    getSessionId: () => string;
    getTurnId: () => string;
    getSignal: () => AbortSignal | undefined;
  }) {
    this._sandbox = options.sandbox;
    this._allowHostPaths = options.allowHostPaths;
    this._getSessionId = options.getSessionId;
    this._getTurnId = options.getTurnId;
    this._getSignal = options.getSignal;
  }

  get root(): string {
    return this._sandbox.root;
  }

  get signal(): AbortSignal | undefined {
    return this._getSignal();
  }

  async operation(spec: ToolFilesystemOperationSpec): Promise<ToolFilesystemOperation> {
    const inputPath = normalizeUserPath(spec.path ?? ".");
    const absolutePath = await this._resolvePath(inputPath);
    const target: ToolFilesystemTarget = {
      inputPath,
      absolutePath,
      displayPath: this.displayPath(absolutePath),
      outsideWorkspace: !this._sandbox.containsPath(absolutePath),
      kind: await pathKind(absolutePath),
      signal: this.signal,
    };
    assertRequiredKind(target, spec.require);
    return new ToolFilesystemOperationImpl(target, spec);
  }

  scoped(options: { allowHostPaths: boolean }): ToolFilesystem {
    return new ToolFilesystemImpl({
      sandbox: this._sandbox,
      allowHostPaths: options.allowHostPaths,
      getSessionId: this._getSessionId,
      getTurnId: this._getTurnId,
      getSignal: this._getSignal,
    });
  }

  displayPath(absolutePath: string): string {
    return this._sandbox.displayPath(absolutePath);
  }

  private async _resolvePath(userPath: string): Promise<string> {
    const expanded = expandTilde(userPath);
    if (path.isAbsolute(expanded) && this._sandbox.containsPath(path.resolve(expanded))) {
      return await this._sandbox.resolvePath(expanded);
    }
    if (isHostPath(userPath) && !this._allowHostPaths) {
      throw new Error("Host paths are not available in this tool context. Use workspace-relative paths.");
    }
    if (isHostPath(userPath)) return path.resolve(expanded);
    return await this._sandbox.resolvePath(userPath);
  }
}

export async function createToolFilesystem(root: string, options: ToolFilesystemOptions = {}): Promise<ToolFilesystem> {
  const sandbox = options.sandbox ?? await WorkspaceSandbox.create(root);
  return new ToolFilesystemImpl({
    sandbox,
    allowHostPaths: options.allowHostPaths ?? true,
    getSessionId: valueGetter(options.sessionId, "unknown-session"),
    getTurnId: valueGetter(options.turnId, "unknown-turn"),
    getSignal: signalGetter(options.signal),
  });
}
