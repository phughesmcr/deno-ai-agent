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
  const queue: {
    request: PermissionPromptRequest;
    signal: AbortSignal;
    resolve: (result: PermissionPromptResult) => void;
  }[] = [];
  const pending = createPendingInteractionStore<PermissionPromptRequest, PermissionPromptResult>((request, result) => {
    shortIds.delete(request.requestId);
    logDebug("permission_prompt.decision", {
      permission: request.permission,
      result: result.result,
      grant: result.grant ?? "",
    });
    queueMicrotask(startNext);
  });

  function denyQueued(): void {
    for (const queued of queue.splice(0)) {
      queued.resolve({ result: "deny" });
    }
  }

  function startNext(): void {
    if (pending.isPending()) return;
    const next = queue.shift();
    if (!next) return;

    const activeTurn = turn;
    if (!activeTurn || next.signal.aborted || activeTurn.signal.aborted) {
      next.resolve({ result: "deny" });
      queueMicrotask(startNext);
      return;
    }

    const shortId = toShortRequestId(next.request.requestId);
    shortIds.set(next.request.requestId, shortId);

    if (
      !pending.begin({
        request: next.request,
        resolve: next.resolve,
        signal: next.signal,
        timeoutMs,
        abortResult: () => ({ result: "deny" }),
        timeoutResult: () => ({ result: "deny" }),
      })
    ) {
      shortIds.delete(next.request.requestId);
      queue.unshift(next);
      return;
    }

    logDebug("permission_prompt.requested", {
      permission: next.request.permission,
      brokerId: String(next.request.brokerId),
      chatId: String(activeTurn.ctx.message?.chat?.id ?? activeTurn.ctx.config.adminId),
      valuePreview: next.request.value?.slice(0, 80) ?? "(none)",
    });
    activeTurn.ctx.reply(promptText(next.request), {
      reply_markup: keyboard(shortId),
      message_thread_id: activeTurn.ctx.message?.message_thread_id,
    }).catch((error: unknown) => {
      logDebug("permission_prompt.send_error", {
        message: error instanceof Error ? error.message : String(error),
        chatId: String(activeTurn.ctx.message?.chat?.id ?? activeTurn.ctx.config.adminId),
      });
      pending.settle({ result: "deny" });
    });
  }

  return {
    isPending: () => pending.isPending() || queue.length > 0,
    setTurnContext(target: PermissionPromptTurnTarget): void {
      turn = target;
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    abortPending(): void {
      pending.settle({ result: "deny" });
      denyQueued();
    },
    async prompt(request: PermissionPromptRequest, signal?: AbortSignal): Promise<PermissionPromptResult> {
      const effectiveSignal = turn?.signal ?? signal;
      if (!turn || !effectiveSignal || effectiveSignal.aborted) {
        return { result: "deny" };
      }

      return await new Promise<PermissionPromptResult>((resolve) => {
        queue.push({ request, signal: effectiveSignal, resolve });
        startNext();
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
        return Promise.resolve({ handled: true, clearReplyMarkup: true });
      }
      pending.settle({
        result: "allow",
        grant: parsed.action === "session" ? "session" : "once",
      });
      return Promise.resolve({ handled: true, clearReplyMarkup: true });
    },
  };
}
