// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.
import type { CapabilityDecisionDelegate, CapabilityPromptDecision, CapabilityRequest } from "../core/mod.ts";
import { errorMessage, logDebug } from "../shared/mod.ts";
import {
  type CapabilityCallbackAction,
  encodeCapabilityCallback,
  parseCapabilityCallback,
  resolveCapabilityRequestId,
  toShortCapabilityRequestId,
} from "./capability-callback.ts";
import { createPendingInteractionStore } from "./pending-interaction.ts";

/** Minimal Telegram inline keyboard markup used for capability prompt buttons. */
export interface CapabilityInlineKeyboardMarkup {
  /** Telegram inline keyboard rows. */
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** Minimal Telegram context needed to send capability prompts. */
export interface TelegramCapabilityTurnContext {
  /** Bot configuration attached by the Telegram manager. */
  config: { adminId: number; isAdmin: boolean };
  /** Source message used to preserve topic/thread routing. */
  message?: { message_thread_id?: number; chat?: { id: number } };
  /** Sends the capability prompt. */
  reply(
    text: string,
    options?: { reply_markup?: CapabilityInlineKeyboardMarkup; message_thread_id?: number },
  ): Promise<{ message_id: number }>;
}

/** Minimal Telegram callback context needed to resolve capability prompts. */
export interface TelegramCapabilityCallbackContext {
  /** Bot configuration attached by the Telegram manager. */
  config: { adminId: number; isAdmin: boolean };
  /** User who tapped the button. */
  from?: { id: number };
  /** Callback query payload. */
  callbackQuery?: { data?: string };
  /** Acknowledges the callback query. */
  answerCallbackQuery(options?: { text?: string; show_alert?: boolean }): Promise<unknown>;
  /** Removes inline buttons after a decision. */
  editMessageReplyMarkup(options?: { reply_markup?: undefined }): Promise<unknown>;
}

/** Active Telegram turn target for capability prompts. */
export interface TelegramCapabilityTurnTarget {
  /** Telegram message context for the active model turn. */
  ctx: TelegramCapabilityTurnContext;
  /** Signal cancelled when the active turn shuts down. */
  signal: AbortSignal;
}

/** Telegram capability prompt delegate plus turn/callback hooks used by the bot adapter. */
export interface TelegramCapabilityPromptPort extends CapabilityDecisionDelegate {
  /** Returns true while a capability prompt is awaiting a button callback. */
  isPending(): boolean;
  /** Binds the prompt port to the Telegram turn currently running the model. */
  setTurnContext(target: TelegramCapabilityTurnTarget): void;
  /** Clears the active Telegram turn context. */
  clearTurnContext(): void;
  /** Denies and clears any in-flight prompt wait. */
  abortPending(): void;
  /** Handles capability callback queries; returns true when consumed. */
  handleCallback(ctx: TelegramCapabilityCallbackContext): Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function decision(
  request: CapabilityRequest,
  decisionValue: "allow" | "deny",
  scope: CapabilityPromptDecision["scope"],
  reason: string,
  decidedBy?: string,
): CapabilityPromptDecision {
  logDebug("capability_prompt.decision", {
    requestId: request.id,
    source: request.source,
    capability: `${request.capability.kind}:${request.capability.action}:${request.capability.target}`,
    decision: decisionValue,
    scope,
    reason,
  });
  return {
    decision: decisionValue,
    scope,
    reason,
    decidedAt: new Date().toISOString(),
    ...(decidedBy !== undefined ? { decidedBy } : {}),
  };
}

function denyDecision(request: CapabilityRequest, reason: string, decidedBy?: string): CapabilityPromptDecision {
  return decision(request, "deny", "once", reason, decidedBy);
}

function allowDecision(
  request: CapabilityRequest,
  scope: "once" | "session",
  decidedBy?: string,
): CapabilityPromptDecision {
  return decision(request, "allow", scope, "approved", decidedBy);
}

function appKeyboard(shortId: string): CapabilityInlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: encodeCapabilityCallback(shortId, "approve") },
      { text: "Deny", callback_data: encodeCapabilityCallback(shortId, "deny") },
    ]],
  };
}

function brokerKeyboard(shortId: string): CapabilityInlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Allow once", callback_data: encodeCapabilityCallback(shortId, "once") },
      { text: "Allow session", callback_data: encodeCapabilityCallback(shortId, "session") },
      { text: "Deny", callback_data: encodeCapabilityCallback(shortId, "deny") },
    ]],
  };
}

function keyboard(request: CapabilityRequest, shortId: string): CapabilityInlineKeyboardMarkup {
  if (request.source === "broker_permission") return brokerKeyboard(shortId);
  return appKeyboard(shortId);
}

function truncateTarget(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function promptText(request: CapabilityRequest): string {
  if (request.source === "broker_permission") {
    const lines = [
      "Permission request",
      `Type: ${request.capability.action}`,
      `Value: ${truncateTarget(request.capability.target)}`,
      "",
      "Approving run grants host-level execution.",
    ];
    return lines.join("\n");
  }

  const lines = [
    `Approval request: ${request.id}`,
    `Source: ${request.source}`,
    `Operation: ${request.display.action}`,
    `Risk: ${request.risk}`,
    `Target: ${request.display.target}`,
    `Session: ${request.sessionId}`,
    `Work: ${request.workId ?? "(none)"}`,
  ];
  if (request.summary) lines.push(`Summary: ${request.summary}`);
  return lines.join("\n");
}

function scopeForAction(action: CapabilityCallbackAction): "once" | "session" {
  return action === "session" ? "session" : "once";
}

/** Telegram inline-keyboard implementation of the capability prompt delegate. */
export function createTelegramCapabilityPromptPort(timeoutMs = DEFAULT_TIMEOUT_MS): TelegramCapabilityPromptPort {
  let turn: TelegramCapabilityTurnTarget | undefined;
  const shortIds = new Map<string, string>();
  const queue: {
    request: CapabilityRequest;
    signal: AbortSignal;
    resolve: (result: CapabilityPromptDecision) => void;
  }[] = [];
  const pending = createPendingInteractionStore<CapabilityRequest, CapabilityPromptDecision>((request) => {
    shortIds.delete(request.id);
    queueMicrotask(startNext);
  });

  function denyQueued(reason: string): void {
    for (const queued of queue.splice(0)) {
      queued.resolve(denyDecision(queued.request, reason));
    }
  }

  function settle(result: CapabilityPromptDecision): void {
    pending.settle(result);
  }

  function startNext(): void {
    if (pending.isPending()) return;
    const next = queue.shift();
    if (!next) return;

    const activeTurn = turn;
    if (!activeTurn || activeTurn.signal.aborted) {
      next.resolve(denyDecision(next.request, "missing_telegram_turn"));
      queueMicrotask(startNext);
      return;
    }
    if (next.signal.aborted) {
      next.resolve(denyDecision(next.request, "cancelled"));
      queueMicrotask(startNext);
      return;
    }

    const shortId = toShortCapabilityRequestId(next.request.id);
    shortIds.set(next.request.id, shortId);

    if (
      !pending.begin({
        request: next.request,
        signal: next.signal,
        timeoutMs: next.request.timeoutMs || timeoutMs,
        resolve: next.resolve,
        abortResult: () => denyDecision(next.request, "cancelled"),
        timeoutResult: () => denyDecision(next.request, "timeout"),
      })
    ) {
      shortIds.delete(next.request.id);
      queue.unshift(next);
      return;
    }

    logDebug("capability_prompt.requested", {
      requestId: next.request.id,
      source: next.request.source,
      risk: next.request.risk,
      sessionId: next.request.sessionId,
      workId: next.request.workId ?? "",
    });
    activeTurn.ctx.reply(promptText(next.request), {
      reply_markup: keyboard(next.request, shortId),
      message_thread_id: activeTurn.ctx.message?.message_thread_id,
    }).catch((error: unknown) => {
      logDebug("capability_prompt.send_error", {
        requestId: next.request.id,
        message: errorMessage(error),
      });
      settle(denyDecision(next.request, "send_failed"));
    });
  }

  return {
    isPending: () => pending.isPending() || queue.length > 0,
    setTurnContext(target: TelegramCapabilityTurnTarget): void {
      turn = target;
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    abortPending(): void {
      const current = pending.current();
      if (current) pending.settle(denyDecision(current.request, "cancelled"));
      denyQueued("cancelled");
    },
    async decide(request: CapabilityRequest, signal?: AbortSignal): Promise<CapabilityPromptDecision> {
      const activeTurn = turn;
      if (!activeTurn || activeTurn.signal.aborted) return denyDecision(request, "missing_telegram_turn");
      const effectiveSignal = signal ?? activeTurn.signal;
      if (effectiveSignal.aborted) return denyDecision(request, "cancelled");

      const wait = Promise.withResolvers<CapabilityPromptDecision>();
      queue.push({ request, signal: effectiveSignal, resolve: wait.resolve });
      startNext();
      return await wait.promise;
    },
    async handleCallback(ctx: TelegramCapabilityCallbackContext): Promise<boolean> {
      const data = ctx.callbackQuery?.data;
      if (!data) return false;
      const parsed = parseCapabilityCallback(data);
      if (!parsed) return false;
      logDebug("capability_prompt.callback", { shortId: parsed.shortId, action: parsed.action });

      const current = pending.current();
      const actorId = ctx.from?.id;
      if (!current) {
        await ctx.answerCallbackQuery({ text: "This approval has expired." });
        logDebug("capability_prompt.stale_callback", { shortId: parsed.shortId });
        return true;
      }

      if (actorId !== ctx.config.adminId) {
        await ctx.answerCallbackQuery({ text: "Not authorized.", show_alert: true });
        return true;
      }

      const requestId = resolveCapabilityRequestId(parsed.shortId, shortIds);
      if (!requestId || requestId !== current.request.id) {
        await ctx.answerCallbackQuery({ text: "This approval has expired." });
        logDebug("capability_prompt.stale_callback", {
          shortId: parsed.shortId,
          pendingId: current.request.id,
          requestId: requestId ?? "",
        });
        return true;
      }

      const result = parsed.action === "deny" ?
        denyDecision(current.request, "denied", actorId === undefined ? undefined : String(actorId)) :
        allowDecision(
          current.request,
          scopeForAction(parsed.action),
          actorId === undefined ? undefined : String(actorId),
        );
      settle(result);

      try {
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch {
          /* message may already be gone */
        }
      } catch (error: unknown) {
        logDebug("capability_prompt.callback_ack_error", {
          message: errorMessage(error),
        });
      }
      return true;
    },
  };
}
