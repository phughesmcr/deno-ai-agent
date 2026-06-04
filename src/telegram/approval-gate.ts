// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.
import {
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  approveDecision,
  denyDecision,
  logDebug,
} from "../shared/mod.ts";
import { createPendingInteractionStore } from "./pending-interaction.ts";

/** Telegram approval button action. */
export type ApprovalAction = "approve" | "deny";

/** Minimal Telegram inline keyboard markup used for approval buttons. */
export interface InlineKeyboardMarkup {
  /** Telegram inline keyboard rows. */
  inline_keyboard: { text: string; callback_data: string }[][];
}

/** Minimal Telegram context needed to send approval prompts. */
export interface TelegramApprovalTurnContext {
  /** Bot configuration attached by the Telegram manager. */
  config: { adminId: number; isAdmin: boolean };
  /** Source message used to preserve topic/thread routing. */
  message?: { message_thread_id?: number };
  /** Sends the approval prompt. */
  reply(
    text: string,
    options?: { reply_markup?: InlineKeyboardMarkup; message_thread_id?: number },
  ): Promise<{ message_id: number }>;
}

/** Minimal Telegram callback context needed to resolve approval prompts. */
export interface TelegramApprovalCallbackContext {
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

/** Active Telegram turn target for approval prompts. */
export interface TelegramTurnTarget {
  /** Telegram message context for the active model turn. */
  ctx: TelegramApprovalTurnContext;
  /** Signal cancelled when the active turn shuts down. */
  signal: AbortSignal;
}

/** Telegram approval gate plus turn/callback hooks used by the bot adapter. */
export interface TelegramApprovalGate extends ApprovalGate {
  /** Returns true while an approval is awaiting a button callback. */
  isPending(): boolean;
  /** Binds the gate to the Telegram turn currently running the model. */
  setTurnContext(target: TelegramTurnTarget): void;
  /** Clears the active Telegram turn context. */
  clearTurnContext(): void;
  /** Denies and clears any in-flight approval wait. */
  abortPending(): void;
  /** Handles approval callback queries; returns true when consumed. */
  handleCallback(ctx: TelegramApprovalCallbackContext): Promise<boolean>;
}

/** Telegram callback_data for approval decisions. */
export function encodeApprovalCallback(id: string, action: ApprovalAction): string {
  return `ag:${id}:${action}`;
}

function parseApprovalCallback(data: string): { id: string; action: ApprovalAction } | undefined {
  const match = /^ag:([^:]+):(approve|deny)$/.exec(data);
  if (!match?.[1] || !match[2]) return undefined;
  return { id: match[1], action: match[2] as ApprovalAction };
}

function keyboard(id: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: encodeApprovalCallback(id, "approve") },
      { text: "Deny", callback_data: encodeApprovalCallback(id, "deny") },
    ]],
  };
}

function requestId(request: ApprovalRequest): string {
  return request.id ?? crypto.randomUUID();
}

function approvalText(request: ApprovalRequest): string {
  const lines = [
    `Approval request: ${request.id}`,
    `Operation: ${request.operation}`,
    `Risk: ${request.risk}`,
    `Target: ${request.target}`,
    `Session: ${request.sessionId}`,
    `Turn: ${request.turnId}`,
  ];
  if (request.summary) lines.push(`Summary: ${request.summary}`);
  return lines.join("\n");
}

/** Telegram inline-keyboard implementation of the app-layer approval gate. */
export function createTelegramApprovalGate(): TelegramApprovalGate {
  let turn: TelegramTurnTarget | undefined;
  const queue: {
    request: ApprovalRequest;
    signal: AbortSignal;
    resolve: (result: ApprovalDecision) => void;
  }[] = [];
  const pending = createPendingInteractionStore<ApprovalRequest, ApprovalDecision>((request, decision) => {
    logDebug("approval.decision", {
      operation: request.operation,
      risk: request.risk,
      sessionId: request.sessionId,
      turnId: request.turnId,
      approved: String(decision.approved),
      reason: decision.reason,
    });
    queueMicrotask(startNext);
  });

  function settle(reason: string, approved: boolean, decidedBy?: string): void {
    const decision = approved ? approveDecision(decidedBy) : denyDecision(reason, decidedBy);
    pending.settle(decision);
  }

  function denyQueued(reason: string): void {
    for (const queued of queue.splice(0)) {
      queued.resolve(denyDecision(reason));
    }
  }

  function startNext(): void {
    if (pending.isPending()) return;
    const next = queue.shift();
    if (!next) return;

    const activeTurn = turn;
    if (!activeTurn || activeTurn.signal.aborted) {
      next.resolve(denyDecision("missing_telegram_turn"));
      queueMicrotask(startNext);
      return;
    }
    if (next.signal.aborted) {
      next.resolve(denyDecision("cancelled"));
      queueMicrotask(startNext);
      return;
    }

    if (
      !pending.begin({
        request: next.request,
        signal: next.signal,
        timeoutMs: next.request.timeoutMs,
        resolve: next.resolve,
        abortResult: () => denyDecision("cancelled"),
        timeoutResult: () => denyDecision("timeout"),
      })
    ) {
      queue.unshift(next);
      return;
    }

    logDebug("approval.requested", {
      operation: next.request.operation,
      risk: next.request.risk,
      sessionId: next.request.sessionId,
      turnId: next.request.turnId,
    });
    activeTurn.ctx.reply(approvalText(next.request), {
      reply_markup: keyboard(next.request.id!),
      message_thread_id: activeTurn.ctx.message?.["message_thread_id"],
    }).catch((error: unknown) => {
      logDebug("approval.send_error", { message: error instanceof Error ? error.message : String(error) });
      settle("send_failed", false);
    });
  }

  return {
    isPending: () => pending.isPending() || queue.length > 0,
    setTurnContext(target: TelegramTurnTarget): void {
      turn = target;
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    abortPending(): void {
      pending.settle(denyDecision("cancelled"));
      denyQueued("cancelled");
    },
    async requestApproval(rawRequest: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
      if (!turn || turn.signal.aborted) return denyDecision("missing_telegram_turn");

      const request = { ...rawRequest, id: requestId(rawRequest) };
      const effectiveSignal = signal ?? turn.signal;
      if (effectiveSignal.aborted) return denyDecision("cancelled");

      return await new Promise<ApprovalDecision>((resolve) => {
        queue.push({ request, signal: effectiveSignal, resolve });
        startNext();
      });
    },
    async handleCallback(ctx: TelegramApprovalCallbackContext): Promise<boolean> {
      const data = ctx.callbackQuery?.data;
      if (!data) return false;
      const parsed = parseApprovalCallback(data);
      if (!parsed) return false;
      logDebug("approval.callback", { id: parsed.id, action: parsed.action });

      const current = pending.current();
      const actorId = ctx.from?.id;
      if (!current) {
        await ctx.answerCallbackQuery({ text: "This approval has expired." });
        logDebug("approval.stale_callback", { id: parsed.id });
        return true;
      }

      if (actorId !== ctx.config.adminId) {
        await ctx.answerCallbackQuery({ text: "Not authorized.", show_alert: true });
        return true;
      }

      if (parsed.id !== current.request.id) {
        await ctx.answerCallbackQuery({ text: "This approval has expired." });
        logDebug("approval.stale_callback", { id: parsed.id, pendingId: current.request.id ?? "" });
        return true;
      }

      const approved = parsed.action === "approve";
      settle(approved ? "approved" : "denied", approved, String(actorId));

      try {
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        } catch {
          /* message may already be gone */
        }
      } catch (error: unknown) {
        logDebug("approval.callback_ack_error", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    },
  };
}
