import { logDebug } from "../log.ts";
import {
  type PermissionPromptPort,
  type PermissionPromptRequest,
  type PermissionPromptResult,
  type PermissionPromptTurnTarget,
} from "../tools/permission-prompt-port.ts";
import {
  encodePermissionCallback,
  parsePermissionCallback,
  resolveRequestId,
  toShortRequestId,
} from "./permission-callback.ts";

interface PendingPermissionPrompt {
  request: PermissionPromptRequest;
  resolve: (result: PermissionPromptResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  abortHandler: () => void;
  signal: AbortSignal;
}

function promptText(request: PermissionPromptRequest): string {
  const value = request.value ?? "(none)";
  const lines = [
    "Permission request",
    `Type: ${request.permission}`,
    `Value: ${value.length > 500 ? `${value.slice(0, 500)}…` : value}`,
    "",
    "Approving run grants host-level execution.",
  ];
  return lines.join("\n");
}

function keyboard(shortId: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [[
      { text: "Allow once", callback_data: encodePermissionCallback(shortId, "once") },
      { text: "Allow session", callback_data: encodePermissionCallback(shortId, "session") },
      { text: "Deny", callback_data: encodePermissionCallback(shortId, "deny") },
    ]],
  };
}

/**
 * Telegram adapter for Deno permission broker prompts.
 * @internal
 */
export function createTelegramPermissionPromptPort(timeoutMs = 120_000): PermissionPromptPort {
  let turn: PermissionPromptTurnTarget | undefined;
  let pending: PendingPermissionPrompt | undefined;
  const shortIds = new Map<string, string>();

  function settle(result: PermissionPromptResult): void {
    const current = pending;
    if (!current) return;
    pending = undefined;
    clearTimeout(current.timeoutId);
    current.signal.removeEventListener("abort", current.abortHandler);
    shortIds.delete(current.request.requestId);
    logDebug("permission_prompt.decision", {
      permission: current.request.permission,
      result: result.result,
      grant: result.grant ?? "",
    });
    current.resolve(result);
  }

  return {
    isPending: () => pending !== undefined,
    setTurnContext(target: PermissionPromptTurnTarget): void {
      turn = target;
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    abortPending(): void {
      settle({ result: "deny" });
    },
    async prompt(request: PermissionPromptRequest, signal?: AbortSignal): Promise<PermissionPromptResult> {
      const effectiveSignal = signal ?? turn?.signal;
      const chatId = turn?.ctx.message?.chat?.id ?? turn?.ctx.config.adminId;
      if (!turn || !effectiveSignal || effectiveSignal.aborted) {
        return { result: "deny" };
      }
      if (pending) return { result: "deny" };

      const shortId = toShortRequestId(request.requestId);
      shortIds.set(request.requestId, shortId);

      return await new Promise<PermissionPromptResult>((resolve) => {
        const abortHandler = (): void => settle({ result: "deny" });
        const timeoutId = setTimeout(() => settle({ result: "deny" }), timeoutMs);
        pending = {
          request,
          resolve,
          timeoutId,
          abortHandler,
          signal: effectiveSignal,
        };
        effectiveSignal.addEventListener("abort", abortHandler, { once: true });

        turn!.ctx.reply(promptText(request), {
          reply_markup: keyboard(shortId),
          message_thread_id: turn!.ctx.message?.message_thread_id,
        }).catch((error: unknown) => {
          logDebug("permission_prompt.send_error", {
            message: error instanceof Error ? error.message : String(error),
            chatId: String(chatId),
          });
          settle({ result: "deny" });
        });
      });
    },
    async handleCallback(data: string, actorId: number | undefined, adminId: number): Promise<boolean> {
      const parsed = parsePermissionCallback(data);
      if (!parsed) return false;

      const current = pending;
      if (!current) {
        logDebug("permission_prompt.stale_callback", { data });
        return true;
      }

      const requestId = resolveRequestId(parsed.shortId, shortIds);
      if (!requestId || requestId !== current.request.requestId) {
        logDebug("permission_prompt.stale_callback", { data, requestId: requestId ?? "" });
        return true;
      }

      if (actorId !== adminId) {
        settle({ result: "deny" });
        return true;
      }

      if (parsed.action === "deny") {
        settle({ result: "deny" });
        return true;
      }
      settle({
        result: "allow",
        grant: parsed.action === "session" ? "session" : "once",
      });
      return true;
    },
  };
}
