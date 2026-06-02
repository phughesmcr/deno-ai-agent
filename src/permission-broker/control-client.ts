import { logDebug } from "../log.ts";
import type { PermissionPromptPort } from "../tools/permission-prompt-port.ts";
import {
  type ControlDecision,
  type ControlPrompt,
  formatControlMessage,
  parseControlMessage,
} from "./control-protocol.ts";
import { readJsonlLine, writeJsonlLine } from "./jsonl.ts";

/** Options for the permission broker control client. */
export interface ControlClientOptions {
  controlPath: string;
  promptPort: PermissionPromptPort;
  reconnectDelayMs?: number;
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
  while (!signal.aborted) {
    try {
      const conn = await Deno.connect({ transport: "unix", path: options.controlPath });
      logDebug("permission_broker.control_connected", { path: options.controlPath });
      await writeJsonlLine(conn, formatControlMessage({ type: "register", pid: Deno.pid }));
      await serveControl(conn, options.promptPort, signal);
      conn.close();
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
  return Deno.env.get("SILAS_PERMISSION_CONTROL_PATH") !== undefined;
}
