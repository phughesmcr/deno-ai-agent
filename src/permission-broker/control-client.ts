import { attachControlConnection, detachControlConnection } from "./control-channel.ts";
import {
  type ControlDecision,
  type ControlPrompt,
  formatControlMessage,
  parseControlMessage,
} from "./control-protocol.ts";
import { logDebug } from "./debug-log.ts";
import { readJsonlLine, writeJsonlLine } from "./jsonl.ts";
import type { PermissionPromptPort } from "./permission-prompt-port.ts";

/** Options for the permission broker control client. */
export interface ControlClientOptions {
  controlPath: string;
  promptPort: PermissionPromptPort;
  reconnectDelayMs?: number;
}

let controlReadyResolve: (() => void) | undefined;

/** Resolves once the control client has connected and sent `register` to the broker. */
export const permissionControlClientReady: Promise<void> = new Promise((resolve) => {
  controlReadyResolve = resolve;
});

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
      const conn = await Deno.connect({ transport: "unix", path: options.controlPath });
      attachControlConnection(conn);
      logDebug("permission_broker.control_connected", { path: options.controlPath });
      try {
        await writeJsonlLine(conn, formatControlMessage({ type: "register", pid: Deno.pid }));
        if (!registered) {
          registered = true;
          markControlReady();
        }
        await serveControl(conn, options.promptPort, signal);
      } finally {
        detachControlConnection();
        conn.close();
      }
    } catch (error) {
      if (signal.aborted) return;
      logDebug("permission_broker.control_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function serveControl(
  conn: Deno.Conn,
  port: PermissionPromptPort,
  signal: AbortSignal,
): Promise<void> {
  const abortHandler = (): void => {
    port.abortPending();
    conn.close();
  };
  signal.addEventListener("abort", abortHandler, { once: true });
  try {
    while (!signal.aborted) {
      const line = await readJsonlLine(conn);
      if (line === null) return;
      const message = parseControlMessage(line);
      if (message.type !== "prompt") continue;
      const decision = await handlePrompt(message, port, signal);
      await writeJsonlLine(conn, formatControlMessage(decision));
    }
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
}

async function handlePrompt(
  prompt: ControlPrompt,
  port: PermissionPromptPort,
  signal: AbortSignal,
): Promise<ControlDecision> {
  const result = await port.prompt({
    requestId: prompt.requestId,
    brokerId: prompt.brokerId,
    permission: prompt.permission,
    value: prompt.value,
  }, signal);

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
