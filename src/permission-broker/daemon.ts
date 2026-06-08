import * as path from "@std/path";
import { z } from "zod/v3";

import {
  type ControlDecision,
  type ControlPrompt,
  formatControlMessage,
  parseControlMessage,
} from "./control-protocol.ts";
import { ControlSocketSession } from "./control-socket.ts";
import { JsonlConnection } from "./jsonl.ts";
import { errorMessage, logDebug } from "./log.ts";
import { normalizeAbsolutePath } from "./paths.ts";
import { createPolicyContext, decidePolicy, type PolicyContext } from "./policy.ts";
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

const brokerDaemonEnvSchema = z.object({
  SILAS_BROKER_LISTEN_PATH: z.string().optional(),
  DENO_PERMISSION_BROKER_PATH: z.string().optional(),
  SILAS_PERMISSION_CONTROL_PATH: z.string().min(1, "SILAS_PERMISSION_CONTROL_PATH is not set"),
  WORKSPACE_PATH: z.string().optional().default(".silas"),
  SILAS_PROJECT_ROOT: z.string().optional(),
  DENO_DIR: z.string().optional(),
  HOME: z.string().optional(),
  PERMISSION_PROMPT_TIMEOUT_MS: z.string().optional().transform((value) => {
    if (value === undefined || value === "") return 120_000;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 120_000;
  }),
  SILAS_PERMISSION_RUN_PROMPTS: z.string().optional().transform((value) => value === "1"),
});

/** Loads daemon configuration from environment variables. */
export function loadBrokerDaemonEnv(): BrokerDaemonEnv {
  const env = brokerDaemonEnvSchema.parse(Deno.env.toObject());
  const brokerPath = env.SILAS_BROKER_LISTEN_PATH ?? env.DENO_PERMISSION_BROKER_PATH;
  if (!brokerPath) throw new Error("SILAS_BROKER_LISTEN_PATH is not set");
  const projectRoot = env.SILAS_PROJECT_ROOT ?? Deno.cwd();
  const denoDir = env.DENO_DIR ?? path.join(env.HOME ?? "", ".cache", "deno");
  return {
    brokerPath,
    controlPath: env.SILAS_PERMISSION_CONTROL_PATH,
    workspacePath: normalizeAbsolutePath(
      path.isAbsolute(env.WORKSPACE_PATH) ? env.WORKSPACE_PATH : path.join(projectRoot, env.WORKSPACE_PATH),
    ),
    projectRoot: normalizeAbsolutePath(projectRoot),
    denoDir: normalizeAbsolutePath(denoDir),
    promptTimeoutMs: env.PERMISSION_PROMPT_TIMEOUT_MS,
    runPromptsEnabled: env.SILAS_PERMISSION_RUN_PROMPTS,
  };
}

interface PendingPrompt {
  requestId: string;
  brokerId: number;
  permission: string;
  value: string | null;
  resolve: (result: BrokerResponse) => void;
}

function isSocketClosedError(error: unknown): boolean {
  if (error instanceof Deno.errors.BadResource) return true;
  const message = errorMessage(error);
  return message.includes("operation canceled") || message.includes("Invalid argument");
}

/**
 * Permission broker daemon: JSONL broker socket + control socket for Telegram UI.
 * @internal
 */
export class PermissionBrokerDaemon {
  private readonly _env: BrokerDaemonEnv;
  private readonly _cache = new SessionCache();
  private _controlConn: Deno.Conn | undefined;
  private _controlSession: ControlSocketSession | undefined;
  private _controlRegistered = false;
  private readonly _brokerConns = new Set<Deno.Conn>();
  private _pending: PendingPrompt | undefined;
  private _promptQueueTail: Promise<void> = Promise.resolve();

  constructor(env: BrokerDaemonEnv) {
    this._env = env;
  }

  private _policyContext(): PolicyContext {
    return createPolicyContext({
      workspaceRoot: this._env.workspacePath,
      projectRoot: this._env.projectRoot,
      denoDir: this._env.denoDir,
      brokerSocketPaths: [this._env.brokerPath, this._env.controlPath],
      runPromptsEnabled: this._env.runPromptsEnabled,
    });
  }

  /** Starts listeners and runs until aborted. */
  async run(signal: AbortSignal): Promise<void> {
    await removeSocketPath(this._env.brokerPath);
    await removeSocketPath(this._env.controlPath);

    const brokerListener = Deno.listen({ transport: "unix", path: this._env.brokerPath });
    const controlListener = Deno.listen({ transport: "unix", path: this._env.controlPath });
    logDebug("permission_broker.listening", {
      brokerPath: this._env.brokerPath,
      controlPath: this._env.controlPath,
      runPrompts: String(this._env.runPromptsEnabled),
    });

    const abortHandler = (): void => {
      for (const conn of this._brokerConns) {
        try {
          conn.close();
        } catch {
          /* already closed */
        }
      }
      this._controlConn?.close();
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
        this._acceptControl(controlListener, signal),
        this._acceptBroker(brokerListener, signal),
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

  private async _acceptBroker(listener: Deno.UnixListener, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let conn: Deno.Conn;
      try {
        // deno-lint-ignore no-await-in-loop -- Listener accepts are inherently sequential.
        conn = await listener.accept();
      } catch (error) {
        if (signal.aborted || isSocketClosedError(error)) return;
        logDebug("permission_broker.accept_error", {
          kind: "broker",
          message: errorMessage(error),
        });
        return;
      }

      if (signal.aborted) return;
      this._brokerConns.add(conn);
      logDebug("permission_broker.client_connected", { kind: "broker" });
      void (async () => {
        try {
          await this._serveBroker(conn);
        } catch (error) {
          if (!signal.aborted && !isSocketClosedError(error)) {
            logDebug("permission_broker.connection_error", {
              kind: "broker",
              message: errorMessage(error),
            });
          }
        } finally {
          this._brokerConns.delete(conn);
          try {
            conn.close();
          } catch {
            /* already closed */
          }
        }
      })();
    }
  }

  private async _acceptControl(listener: Deno.UnixListener, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let conn: Deno.Conn;
      try {
        // deno-lint-ignore no-await-in-loop -- Listener accepts are inherently sequential.
        conn = await listener.accept();
      } catch (error) {
        if (signal.aborted || isSocketClosedError(error)) return;
        logDebug("permission_broker.accept_error", {
          kind: "control",
          message: errorMessage(error),
        });
        return;
      }

      if (signal.aborted) return;
      if (this._controlConn) {
        conn.close();
        continue;
      }
      this._controlConn = conn;
      logDebug("permission_broker.client_connected", { kind: "control" });
      try {
        // deno-lint-ignore no-await-in-loop -- The daemon serves one control client before accepting a replacement.
        await this._serveControl(conn);
      } catch (error) {
        if (!signal.aborted && !isSocketClosedError(error)) {
          logDebug("permission_broker.connection_error", {
            kind: "control",
            message: errorMessage(error),
          });
        }
      } finally {
        this._abortPrompt();
        this._controlConn = undefined;
        this._controlSession = undefined;
        this._controlRegistered = false;
        try {
          conn.close();
        } catch {
          /* already closed */
        }
      }
    }
  }

  private async _serveControl(conn: Deno.Conn): Promise<void> {
    const session = new ControlSocketSession();
    session.attach(conn);
    this._controlSession = session;
    while (true) {
      // deno-lint-ignore no-await-in-loop -- Control messages must be processed in socket order.
      const line = await session.readLine();
      if (line === null) return;
      const message = parseControlMessage(line);
      if (message.type === "register") {
        this._controlRegistered = true;
        logDebug("permission_broker.control_registered", { pid: String(message.pid) });
        continue;
      }
      if (message.type === "heartbeat") {
        logDebug("permission_broker.control_heartbeat", {
          pid: String(message.pid),
          sentAt: message.sentAt,
        });
        continue;
      }
      if (message.type === "grant") {
        this._cache.grant(message.permission, message.value, message.scope);
        logDebug("permission_broker.grant", {
          permission: message.permission,
          value: message.value ?? "",
          scope: message.scope,
        });
        continue;
      }
      if (message.type === "decision") {
        this._resolvePrompt(message);
        continue;
      }
      if (message.type === "abort") {
        this._abortPrompt(message.requestId);
      }
    }
  }

  private async _serveBroker(conn: Deno.Conn): Promise<void> {
    const jsonl = new JsonlConnection(conn);
    while (true) {
      // deno-lint-ignore no-await-in-loop -- Broker requests must be answered in request order.
      const line = await jsonl.readLine();
      if (line === null) return;
      const request = parseBrokerRequest(line);
      // deno-lint-ignore no-await-in-loop -- Each Deno request must receive its matching response before the next.
      const response = await this._handleRequest(request);
      // deno-lint-ignore no-await-in-loop -- Responses must be written in request order.
      await jsonl.writeLine(formatBrokerResponse(response));
    }
  }

  private async _handleRequest(request: ReturnType<typeof parseBrokerRequest>): Promise<BrokerResponse> {
    const ctx = this._policyContext();
    const value = normalizeBrokerValue(request.value);
    const decision = this._cache.consume(request.permission, value) ? "auto_allow" : decidePolicy(request, ctx);
    const finalDecision = decision === "prompt" && !this._controlRegistered ? "auto_deny" : decision;

    logDebug("permission_broker.request", {
      id: String(request.id),
      permission: request.permission,
      decision: finalDecision,
      value: value ?? "",
    });

    if (finalDecision === "auto_allow") {
      return { id: request.id, result: "allow" };
    }
    if (finalDecision === "auto_deny") {
      return { id: request.id, result: "deny", reason: "Denied by policy." };
    }
    return await this._promptUser(request.id, request.permission, value);
  }

  private async _promptUser(brokerId: number, permission: string, value: string | null): Promise<BrokerResponse> {
    return await this._enqueuePrompt(() => this._promptUserNow(brokerId, permission, value));
  }

  async _enqueuePrompt(task: () => Promise<BrokerResponse>): Promise<BrokerResponse> {
    const previous = this._promptQueueTail;
    const gate = Promise.withResolvers<void>();
    this._promptQueueTail = gate.promise;
    await previous;
    try {
      return await task();
    } finally {
      gate.resolve();
    }
  }

  async _promptUserNow(brokerId: number, permission: string, value: string | null): Promise<BrokerResponse> {
    if (!this._controlConn || !this._controlRegistered) {
      return { id: brokerId, result: "deny", reason: "Control client not registered." };
    }

    const requestId = crypto.randomUUID();
    const prompt: ControlPrompt = {
      type: "prompt",
      requestId,
      brokerId,
      permission,
      value,
    };

    const session = this._controlSession;
    if (!session) {
      return { id: brokerId, result: "deny", reason: "Control session not ready." };
    }

    const response = Promise.withResolvers<BrokerResponse>();
    const timeoutId = setTimeout(() => {
      this._pending = undefined;
      response.resolve({ id: brokerId, result: "deny", reason: "Permission prompt timed out." });
    }, this._env.promptTimeoutMs);
    using timeoutCleanup = { [Symbol.dispose]: () => clearTimeout(timeoutId) };
    void timeoutCleanup;

    this._pending = {
      requestId,
      brokerId,
      permission,
      value,
      resolve: (result) => {
        this._pending = undefined;
        response.resolve(result);
      },
    };

    session.writeLine(formatControlMessage(prompt)).catch(() => {
      this._pending = undefined;
      response.resolve({ id: brokerId, result: "deny", reason: "Failed to send control prompt." });
    });

    return await response.promise;
  }

  private _resolvePrompt(decision: ControlDecision): void {
    const current = this._pending;
    if (!current || decision.requestId !== current.requestId) return;

    if (decision.result === "allow") {
      if (decision.grant === "session") {
        this._cache.grant(current.permission, current.value, "session");
      }
      current.resolve({ id: current.brokerId, result: "allow" });
      return;
    }
    current.resolve({ id: current.brokerId, result: "deny", reason: "Denied by user." });
  }

  private _abortPrompt(requestId?: string): void {
    const current = this._pending;
    if (!current) return;
    if (requestId !== undefined && requestId !== current.requestId) return;
    current.resolve({ id: current.brokerId, result: "deny", reason: "Permission prompt aborted." });
  }
}
