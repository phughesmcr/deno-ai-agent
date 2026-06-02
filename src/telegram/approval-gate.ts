// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.
import {
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  approveDecision,
  denyDecision,
  logDebug,
} from "../shared/mod.ts";
import { getShellCommand } from "../agent/mod.ts";
import { grantBrokerReadPaths, sendControlGrant, shouldRunPermissionControlClient } from "../permission-broker/mod.ts";

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

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  abortHandler: () => void;
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
  let pending: PendingApproval | undefined;

  function settle(reason: string, approved: boolean, decidedBy?: string): void {
    const current = pending;
    if (!current) return;
    pending = undefined;
    clearTimeout(current.timeoutId);
    current.signal.removeEventListener("abort", current.abortHandler);
    const decision = approved ? approveDecision(decidedBy) : denyDecision(reason, decidedBy);
    logDebug("approval.decision", {
      operation: current.request.operation,
      risk: current.request.risk,
      sessionId: current.request.sessionId,
      turnId: current.request.turnId,
      approved: String(decision.approved),
      reason: decision.reason,
    });
    current.resolve(decision);
  }

  return {
    isPending: () => pending !== undefined,
    setTurnContext(target: TelegramTurnTarget): void {
      turn = target;
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    async requestApproval(rawRequest: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
      if (!turn || turn.signal.aborted) return denyDecision("missing_telegram_turn");
      if (pending) return denyDecision("approval_already_pending");

      const request = { ...rawRequest, id: requestId(rawRequest) };
      const effectiveSignal = signal ?? turn.signal;
      if (effectiveSignal.aborted) return denyDecision("cancelled");

      return await new Promise<ApprovalDecision>((resolve) => {
        const abortHandler = (): void => settle("cancelled", false);
        const timeoutId = setTimeout(() => settle("timeout", false), request.timeoutMs);
        pending = { request, resolve, timeoutId, abortHandler, signal: effectiveSignal };
        effectiveSignal.addEventListener("abort", abortHandler, { once: true });

        console.log(`Approval requested: ${request.operation} → ${request.target}`);
        turn?.ctx.reply(approvalText(request), {
          reply_markup: keyboard(request.id),
          message_thread_id: turn.ctx.message?.["message_thread_id"],
        }).catch((error: unknown) => {
          logDebug("approval.send_error", { message: error instanceof Error ? error.message : String(error) });
          settle("send_failed", false);
        });
      });
    },
    async handleCallback(ctx: TelegramApprovalCallbackContext): Promise<boolean> {
      const data = ctx.callbackQuery?.data;
      if (!data) return false;
      const parsed = parseApprovalCallback(data);
      if (!parsed) return false;
      logDebug("approval.callback", { id: parsed.id, action: parsed.action });

      const current = pending;
      const actorId = ctx.from?.id;
      if (!current) {
        await ctx.answerCallbackQuery({ text: "This approval has expired." });
        logDebug("approval.stale_callback", { id: parsed.id });
        return true;
      }

      if (actorId !== ctx.config.adminId) {
        await ctx.answerCallbackQuery({ text: "Not authorized.", show_alert: true });
        settle("wrong_user", false, actorId === undefined ? undefined : String(actorId));
        return true;
      }

      if (parsed.id !== current.request.id) {
        await ctx.answerCallbackQuery({ text: "This approval has expired." });
        logDebug("approval.stale_callback", { id: parsed.id, pendingId: current.request.id ?? "" });
        return true;
      }

      const approved = parsed.action === "approve";
      settle(approved ? "approved" : "denied", approved, String(actorId));

      if (approved && shouldRunPermissionControlClient()) {
        try {
          if (current.request.operation === "shell") {
            const { cmd } = getShellCommand();
            await sendControlGrant("run", cmd, "session");
            await sendControlGrant("run", current.request.target, "session");
          } else if (current.request.operation === "read" && current.request.target.startsWith("/")) {
            await grantBrokerReadPaths(current.request.target);
          }
        } catch (error: unknown) {
          logDebug("approval.pregrant_error", {
            operation: current.request.operation,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

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
