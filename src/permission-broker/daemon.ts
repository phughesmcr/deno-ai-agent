import * as path from "@std/path";

import { logDebug } from "../log.ts";
import {
  type ControlDecision,
  type ControlPrompt,
  formatControlMessage,
  parseControlMessage,
} from "./control-protocol.ts";
import { readJsonlLine, writeJsonlLine } from "./jsonl.ts";
import { normalizeAbsolutePath } from "./paths.ts";
import { createPolicyContext, decidePolicy, effectiveDecision, type PolicyContext } from "./policy.ts";
import { type BrokerResponse, formatBrokerResponse, normalizeBrokerValue, parseBrokerRequest } from "./protocol.ts";
import { SessionCache } from "./session-cache.ts";
import { removeSocketPath } from "./socket-path.ts";

/** Environment for the permission broker daemon. */
export interface BrokerDaemonEnv {
  brokerPath: string;
  controlPath: string;
  workspacePath: string;
  projectRoot: string;
  denoDir: string;
  promptTimeoutMs: number;
  runPromptsEnabled: boolean;
}

/** Loads daemon configuration from environment variables. */
export function loadBrokerDaemonEnv(): BrokerDaemonEnv {
  const brokerPath = Deno.env.get("SILAS_BROKER_LISTEN_PATH") ?? Deno.env.get("DENO_PERMISSION_BROKER_PATH");
  if (!brokerPath) throw new Error("SILAS_BROKER_LISTEN_PATH is not set");
  const controlPath = Deno.env.get("SILAS_PERMISSION_CONTROL_PATH");
  if (!controlPath) throw new Error("SILAS_PERMISSION_CONTROL_PATH is not set");
  const workspacePath = Deno.env.get("WORKSPACE_PATH") ?? ".silas";
  const projectRoot = Deno.env.get("SILAS_PROJECT_ROOT") ?? Deno.cwd();
  const denoDir = Deno.env.get("DENO_DIR") ?? path.join(Deno.env.get("HOME") ?? "", ".cache", "deno");
  const promptTimeoutMs = Number(Deno.env.get("PERMISSION_PROMPT_TIMEOUT_MS") ?? "120000");
  const runPromptsEnabled = Deno.env.get("SILAS_PERMISSION_RUN_PROMPTS") === "1";
  return {
    brokerPath,
    controlPath,
    workspacePath: normalizeAbsolutePath(
      path.isAbsolute(workspacePath) ? workspacePath : path.join(projectRoot, workspacePath),
    ),
    projectRoot: normalizeAbsolutePath(projectRoot),
    denoDir: normalizeAbsolutePath(denoDir),
    promptTimeoutMs: Number.isFinite(promptTimeoutMs) ? promptTimeoutMs : 120_000,
    runPromptsEnabled,
  };
}

interface PendingPrompt {
  requestId: string;
  brokerId: number;
  permission: string;
  value: string | null;
  resolve: (result: BrokerResponse) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

function isSocketClosedError(error: unknown): boolean {
  if (error instanceof Deno.errors.BadResource) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("operation canceled") || message.includes("Invalid argument");
}

/**
 * Permission broker daemon: JSONL broker socket + control socket for Telegram UI.
 * @internal
 */
export class PermissionBrokerDaemon {
  readonly #env: BrokerDaemonEnv;
  readonly #cache = new SessionCache();
  #controlConn: Deno.Conn | undefined;
  #controlRegistered = false;
  readonly #brokerConns = new Set<Deno.Conn>();
  #pending: PendingPrompt | undefined;

  constructor(env: BrokerDaemonEnv) {
    this.#env = env;
  }

  #policyContext(): PolicyContext {
    return createPolicyContext({
      workspaceRoot: this.#env.workspacePath,
      projectRoot: this.#env.projectRoot,
      denoDir: this.#env.denoDir,
      brokerSocketPaths: [this.#env.brokerPath, this.#env.controlPath],
      runPromptsEnabled: this.#env.runPromptsEnabled,
      controlRegistered: this.#controlRegistered,
      cache: this.#cache,
    });
  }

  /** Starts listeners and runs until aborted. */
  async run(signal: AbortSignal): Promise<void> {
    await removeSocketPath(this.#env.brokerPath);
    await removeSocketPath(this.#env.controlPath);

    const brokerListener = Deno.listen({ transport: "unix", path: this.#env.brokerPath });
    const controlListener = Deno.listen({ transport: "unix", path: this.#env.controlPath });
    logDebug("permission_broker.listening", {
      brokerPath: this.#env.brokerPath,
      controlPath: this.#env.controlPath,
      runPrompts: String(this.#env.runPromptsEnabled),
    });

    const abortHandler = (): void => {
      for (const conn of this.#brokerConns) {
        try {
          conn.close();
        } catch {
          /* already closed */
        }
      }
      this.#controlConn?.close();
      try {
        brokerListener.close();
      } catch {
        /* already closed */
      }
      try {
        controlListener.close();
      } catch {
        /* already closed */
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });

    try {
      await Promise.all([
        this.#acceptControl(controlListener, signal),
        this.#acceptBroker(brokerListener, signal),
      ]);
    } finally {
      signal.removeEventListener("abort", abortHandler);
      try {
        brokerListener.close();
      } catch {
        /* already closed */
      }
      try {
        controlListener.close();
      } catch {
        /* already closed */
      }
    }
  }

  async #acceptBroker(listener: Deno.UnixListener, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let conn: Deno.Conn;
      try {
        conn = await listener.accept();
      } catch (error) {
        if (signal.aborted || isSocketClosedError(error)) return;
        logDebug("permission_broker.accept_error", {
          kind: "broker",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (signal.aborted) return;
      this.#brokerConns.add(conn);
      logDebug("permission_broker.client_connected", { kind: "broker" });
      void (async () => {
        try {
          await this.#serveBroker(conn);
        } catch (error) {
          if (!signal.aborted && !isSocketClosedError(error)) {
            logDebug("permission_broker.connection_error", {
              kind: "broker",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          this.#brokerConns.delete(conn);
          try {
            conn.close();
          } catch {
            /* already closed */
          }
        }
      })();
    }
  }

  async #acceptControl(listener: Deno.UnixListener, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let conn: Deno.Conn;
      try {
        conn = await listener.accept();
      } catch (error) {
        if (signal.aborted || isSocketClosedError(error)) return;
        logDebug("permission_broker.accept_error", {
          kind: "control",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (signal.aborted) return;
      if (this.#controlConn) {
        conn.close();
        continue;
      }
      this.#controlConn = conn;
      logDebug("permission_broker.client_connected", { kind: "control" });
      try {
        await this.#serveControl(conn);
      } catch (error) {
        if (!signal.aborted && !isSocketClosedError(error)) {
          logDebug("permission_broker.connection_error", {
            kind: "control",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        this.#controlConn = undefined;
        this.#controlRegistered = false;
        try {
          conn.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  async #serveControl(conn: Deno.Conn): Promise<void> {
    while (true) {
      const line = await readJsonlLine(conn);
      if (line === null) return;
      const message = parseControlMessage(line);
      if (message.type === "register") {
        this.#controlRegistered = true;
        logDebug("permission_broker.control_registered", { pid: String(message.pid) });
        continue;
      }
      if (message.type === "grant") {
        this.#cache.grant(message.permission, message.value, message.scope);
        logDebug("permission_broker.grant", {
          permission: message.permission,
          value: message.value ?? "",
          scope: message.scope,
        });
        continue;
      }
      if (message.type === "decision") {
        this.#resolvePrompt(message);
        continue;
      }
      if (message.type === "abort") {
        this.#abortPrompt(message.requestId);
      }
    }
  }

  async #serveBroker(conn: Deno.Conn): Promise<void> {
    while (true) {
      const line = await readJsonlLine(conn);
      if (line === null) return;
      const request = parseBrokerRequest(line);
      const response = await this.#handleRequest(request);
      await writeJsonlLine(conn, formatBrokerResponse(response));
    }
  }

  async #handleRequest(request: ReturnType<typeof parseBrokerRequest>): Promise<BrokerResponse> {
    const ctx = this.#policyContext();
    const raw = decidePolicy(request, ctx);
    const decision = effectiveDecision(raw, ctx);
    const value = normalizeBrokerValue(request.value);

    logDebug("permission_broker.request", {
      id: String(request.id),
      permission: request.permission,
      decision,
      value: value ?? "",
    });

    if (decision === "auto_allow") {
      if (this.#cache.has(request.permission, value)) {
        this.#cache.consumeOnce(request.permission, value);
      }
      return { id: request.id, result: "allow" };
    }
    if (decision === "auto_deny") {
      return { id: request.id, result: "deny", reason: "Denied by policy." };
    }
    return await this.#promptUser(request.id, request.permission, value);
  }

  async #promptUser(brokerId: number, permission: string, value: string | null): Promise<BrokerResponse> {
    if (!this.#controlConn || !this.#controlRegistered) {
      return { id: brokerId, result: "deny", reason: "Control client not registered." };
    }
    if (this.#pending) {
      return { id: brokerId, result: "deny", reason: "Another permission prompt is pending." };
    }

    const requestId = crypto.randomUUID();
    const prompt: ControlPrompt = {
      type: "prompt",
      requestId,
      brokerId,
      permission,
      value,
    };

    return await new Promise<BrokerResponse>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.#pending = undefined;
        resolve({ id: brokerId, result: "deny", reason: "Permission prompt timed out." });
      }, this.#env.promptTimeoutMs);

      this.#pending = {
        requestId,
        brokerId,
        permission,
        value,
        resolve: (response) => {
          clearTimeout(timeoutId);
          this.#pending = undefined;
          resolve(response);
        },
        timeoutId,
      };

      writeJsonlLine(this.#controlConn!, formatControlMessage(prompt)).catch(() => {
        clearTimeout(timeoutId);
        this.#pending = undefined;
        resolve({ id: brokerId, result: "deny", reason: "Failed to send control prompt." });
      });
    });
  }

  #resolvePrompt(decision: ControlDecision): void {
    const current = this.#pending;
    if (!current || decision.requestId !== current.requestId) return;

    if (decision.result === "allow") {
      if (decision.grant === "session") {
        this.#cache.grant(current.permission, current.value, "session");
      }
      current.resolve({ id: current.brokerId, result: "allow" });
      return;
    }
    current.resolve({ id: current.brokerId, result: "deny", reason: "Denied by user." });
  }

  #abortPrompt(requestId?: string): void {
    const current = this.#pending;
    if (!current) return;
    if (requestId !== undefined && requestId !== current.requestId) return;
    current.resolve({ id: current.brokerId, result: "deny", reason: "Permission prompt aborted." });
  }
}
