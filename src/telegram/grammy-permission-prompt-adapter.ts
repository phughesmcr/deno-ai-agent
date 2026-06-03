import type {
  PermissionCallbackDispatch,
  PermissionPromptPort,
  PermissionPromptRequest,
  PermissionPromptResult,
  PermissionPromptTurnTarget,
} from "../permission-broker/mod.ts";
import { logDebug } from "../shared/mod.ts";
import { createPendingInteractionStore } from "./pending-interaction.ts";
import {
  encodePermissionCallback,
  parsePermissionCallback,
  resolveRequestId,
  toShortRequestId,
} from "./permission-callback.ts";

function promptText(request: PermissionPromptRequest): string {
  const value = request.value ?? "(none)";
  const lines = [
    "Permission request",
    `Type: ${request.permission}`,
    `Value: ${value.length > 500 ? `${value.slice(0, 500)}...` : value}`,
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
  const shortIds = new Map<string, string>();
  const pending = createPendingInteractionStore<PermissionPromptRequest, PermissionPromptResult>((request, result) => {
    shortIds.delete(request.requestId);
    logDebug("permission_prompt.decision", {
      permission: request.permission,
      result: result.result,
      grant: result.grant ?? "",
    });
  });

  return {
    isPending: () => pending.isPending(),
    setTurnContext(target: PermissionPromptTurnTarget): void {
      turn = target;
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    abortPending(): void {
      pending.settle({ result: "deny" });
    },
    async prompt(request: PermissionPromptRequest, signal?: AbortSignal): Promise<PermissionPromptResult> {
      const effectiveSignal = turn?.signal ?? signal;
      const chatId = turn?.ctx.message?.chat?.id ?? turn?.ctx.config.adminId;
      if (!turn || !effectiveSignal || effectiveSignal.aborted) {
        return { result: "deny" };
      }
      if (pending.isPending()) return { result: "deny" };

      const shortId = toShortRequestId(request.requestId);
      shortIds.set(request.requestId, shortId);

      return await new Promise<PermissionPromptResult>((resolve) => {
        if (
          !pending.begin({
            request,
            resolve,
            signal: effectiveSignal,
            timeoutMs,
            abortResult: () => ({ result: "deny" }),
            timeoutResult: () => ({ result: "deny" }),
          })
        ) {
          shortIds.delete(request.requestId);
          resolve({ result: "deny" });
          return;
        }

        logDebug("permission_prompt.requested", {
          permission: request.permission,
          brokerId: String(request.brokerId),
          chatId: String(chatId),
        });
        const valuePreview = request.value ?? "(none)";
        console.log(
          `Broker permission prompt (${request.permission}): respond in Telegram — ${
            valuePreview.length > 80 ? `${valuePreview.slice(0, 80)}...` : valuePreview
          }`,
        );
        turn!.ctx.reply(promptText(request), {
          reply_markup: keyboard(shortId),
          message_thread_id: turn!.ctx.message?.message_thread_id,
        }).catch((error: unknown) => {
          logDebug("permission_prompt.send_error", {
            message: error instanceof Error ? error.message : String(error),
            chatId: String(chatId),
          });
          pending.settle({ result: "deny" });
        });
      });
    },
    handleCallback(data: string, actorId: number | undefined, adminId: number): Promise<PermissionCallbackDispatch> {
      const parsed = parsePermissionCallback(data);
      if (!parsed) return Promise.resolve({ handled: false });

      const current = pending.current();
      if (!current) {
        logDebug("permission_prompt.stale_callback", { data });
        return Promise.resolve({
          handled: true,
          answer: { text: "This permission prompt has expired.", show_alert: true },
        });
      }

      const requestId = resolveRequestId(parsed.shortId, shortIds);
      if (!requestId || requestId !== current.request.requestId) {
        logDebug("permission_prompt.stale_callback", { data, requestId: requestId ?? "" });
        return Promise.resolve({
          handled: true,
          answer: { text: "This permission prompt has expired.", show_alert: true },
        });
      }

      if (actorId !== adminId) {
        logDebug("permission_prompt.unauthorized_callback", {
          actorId: actorId === undefined ? "" : String(actorId),
        });
        return Promise.resolve({
          handled: true,
          answer: { text: "Not authorized.", show_alert: true },
        });
      }

      if (parsed.action === "deny") {
        pending.settle({ result: "deny" });
        return Promise.resolve({ handled: true });
      }
      pending.settle({
        result: "allow",
        grant: parsed.action === "session" ? "session" : "once",
      });
      return Promise.resolve({ handled: true });
    },
  };
}
