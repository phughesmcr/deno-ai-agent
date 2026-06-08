import {
  attachControlConnection,
  detachControlConnection,
  readControlLine,
  writeControlLine,
} from "./control-channel.ts";
import {
  type ControlDecision,
  type ControlPrompt,
  formatControlMessage,
  parseControlMessage,
} from "./control-protocol.ts";
import { errorMessage, logDebug } from "./log.ts";
import type { PermissionPromptPort } from "./permission-prompt-port.ts";

/** Options for the permission broker control client. */
export interface ControlClientOptions {
  controlPath: string;
  promptPort: PermissionPromptPort;
  reconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
}

const controlReady = Promise.withResolvers<void>();
const CONTROL_HEARTBEAT_INTERVAL_MS = 30_000;
let controlReadyResolve: (() => void) | undefined = controlReady.resolve;

/** Resolves once the control client has connected and sent `register` to the broker. */
export const permissionControlClientReady: Promise<void> = controlReady.promise;

function markControlReady(): void {
  controlReadyResolve?.();
  controlReadyResolve = undefined;
}

/** Waits for the control client to register with the broker (no-op if broker is off). */
export async function waitForPermissionControlClient(timeoutMs = 15_000): Promise<void> {
  if (!shouldRunPermissionControlClient()) return;
  await Promise.race([
    permissionControlClientReady,
    new Promise<void>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("Permission control client did not register with the broker in time.")),
        timeoutMs,
      );
    }),
  ]);
}

/**
 * Connects main to the broker daemon control socket and drives Telegram prompts.
 * @internal
 */
export async function runPermissionControlClient(
  options: ControlClientOptions,
  signal: AbortSignal,
): Promise<void> {
  const delay = options.reconnectDelayMs ?? 1000;
  let registered = false;
  while (!signal.aborted) {
    try {
      // deno-lint-ignore no-await-in-loop -- Reconnect attempts must be sequential.
      const conn = await Deno.connect({ transport: "unix", path: options.controlPath });
      attachControlConnection(conn);
      logDebug("permission_broker.control_connected", { path: options.controlPath });
      try {
        // deno-lint-ignore no-await-in-loop -- Registration belongs to the current sequential connection attempt.
        await writeControlLine(formatControlMessage({ type: "register", pid: Deno.pid }));
        if (!registered) {
          registered = true;
          markControlReady();
        }
        // deno-lint-ignore no-await-in-loop -- Serving one control connection completes before reconnecting.
        await serveControl(
          conn,
          options.promptPort,
          signal,
          options.heartbeatIntervalMs ?? CONTROL_HEARTBEAT_INTERVAL_MS,
        );
      } finally {
        detachControlConnection();
        conn.close();
      }
    } catch (error) {
      if (signal.aborted) return;
      logDebug("permission_broker.control_error", {
        message: errorMessage(error),
      });
      // deno-lint-ignore no-await-in-loop -- Backoff belongs between sequential reconnect attempts.
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function serveControl(
  conn: Deno.Conn,
  port: PermissionPromptPort,
  signal: AbortSignal,
  heartbeatIntervalMs: number,
): Promise<void> {
  const heartbeatId = setInterval(() => {
    void sendHeartbeat(conn, port, signal);
  }, heartbeatIntervalMs);
  using heartbeatCleanup = { [Symbol.dispose]: () => clearInterval(heartbeatId) };
  void heartbeatCleanup;

  const abortHandler = (): void => {
    port.abortPending();
    conn.close();
  };
  signal.addEventListener("abort", abortHandler, { once: true });
  try {
    while (!signal.aborted) {
      // deno-lint-ignore no-await-in-loop -- Control prompts must be handled in socket order.
      const line = await readControlLine();
      if (line === null) return;
      const message = parseControlMessage(line);
      if (message.type !== "prompt") continue;
      // deno-lint-ignore no-await-in-loop -- Prompt decisions must preserve request ordering.
      const decision = await handlePrompt(message, port);
      // deno-lint-ignore no-await-in-loop -- Prompt responses must be written in socket order.
      await writeControlLine(formatControlMessage(decision));
    }
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
}

async function sendHeartbeat(conn: Deno.Conn, port: PermissionPromptPort, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  try {
    await writeControlLine(
      formatControlMessage({
        type: "heartbeat",
        pid: Deno.pid,
        sentAt: new Date().toISOString(),
      }),
      signal,
    );
  } catch {
    port.abortPending();
    conn.close();
  }
}

async function handlePrompt(
  prompt: ControlPrompt,
  port: PermissionPromptPort,
): Promise<ControlDecision> {
  const result = await port.prompt({
    requestId: prompt.requestId,
    brokerId: prompt.brokerId,
    permission: prompt.permission,
    value: prompt.value,
  });

  if (result.result === "allow") {
    return {
      type: "decision",
      requestId: prompt.requestId,
      result: "allow",
      grant: result.grant,
    };
  }
  return { type: "decision", requestId: prompt.requestId, result: "deny" };
}

/** Returns true when the process should attach to a permission broker control socket. */
export function shouldRunPermissionControlClient(): boolean {
  try {
    return Deno.env.get("SILAS_PERMISSION_CONTROL_PATH") !== undefined;
  } catch {
    return false;
  }
}
