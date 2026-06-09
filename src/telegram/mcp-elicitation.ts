import { InlineKeyboard } from "grammy";

import type { Question } from "../agent/mod.ts";
import {
  formatElicitationReview,
  parseNumberAnswer,
  planElicitationForm,
  validateElicitationContent,
} from "../agent/tools/elicitation-form.ts";
import type {
  ElicitationFormStep,
  McpFormRequest,
  McpUrlRequest,
  UserInteractionResult,
} from "../agent/tools/user-interaction.ts";
import { UserQuestionAbortedError, UserQuestionDeclinedError } from "../agent/tools/user-interaction.ts";
import { escapeMarkdownV2 } from "./markdown.ts";
import type { TelegramContext } from "./telegram.ts";
import { askMultiSelect, askSingleSelect, askWithAbort, nextInteractionSessionId } from "./user-question-ask.ts";
import { encodeCancelCallback } from "./user-question-callback.ts";

const REVIEW_ACCEPT = "review_accept";
const REVIEW_EDIT = "review_edit";
const REVIEW_CANCEL = "review_cancel";
const URL_DONE = "url_done";
const URL_DECLINE = "url_decline";
const BOOL_YES = "bool_yes";
const BOOL_NO = "bool_no";

function mcpServerLabel(serverId: string, serverTitle?: string): string {
  return serverTitle ? `${serverTitle} (${serverId})` : serverId;
}

function parseUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Runs one MCP elicitation form: collect each field, review, validate, retry. */
export async function interactMcpForm(
  ctx: TelegramContext,
  request: McpFormRequest,
  signal: AbortSignal,
): Promise<UserInteractionResult> {
  const maxAttempts = request.maxAttempts ?? 3;
  const label = mcpServerLabel(request.serverId, request.serverTitle);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const plan = planElicitationForm(request.message, request.requestedSchema);
    const draft: Record<string, unknown> = {};

    for (const step of plan.steps) {
      const value = await collectFormStep(ctx, step, plan.message, label, signal);
      if (value === "decline") return { action: "decline" };
      if (value === "cancel") return { action: "cancel" };
      draft[step.fieldName] = value;
    }

    const review = await reviewForm(ctx, label, plan.message, draft, signal);
    if (review === "decline") return { action: "decline" };
    if (review === "cancel") return { action: "cancel" };
    if (review === "edit") continue;

    const validationError = validateElicitationContent(plan.schema, draft);
    if (validationError) {
      await ctx.reply(`Validation failed: ${validationError}\nPlease try again.`);
      continue;
    }
    return { action: "accept", content: draft };
  }

  return { action: "decline" };
}

async function collectFormStep(
  ctx: TelegramContext,
  step: ElicitationFormStep,
  formMessage: string,
  serverLabel: string,
  signal: AbortSignal,
): Promise<unknown | "decline" | "cancel"> {
  const prefix = `MCP server: ${serverLabel}\n${formMessage}\n\n`;
  const sessionId = nextInteractionSessionId();

  switch (step.kind) {
    case "boolean": {
      const body = `${prefix}*${step.title}*${step.description ? `\n${step.description}` : ""}`;
      const result = await askMcpChoice(
        ctx,
        sessionId,
        body,
        [
          { data: `${sessionId}:${BOOL_YES}`, label: "Yes" },
          { data: `${sessionId}:${BOOL_NO}`, label: "No" },
          { data: encodeCancelCallback(sessionId), label: "Cancel" },
        ],
        signal,
        true,
      );
      if (result === "decline" || result === "cancel") return result;
      return result.endsWith(BOOL_YES);
    }
    case "number": {
      const body = `${prefix}*${step.title}*${step.description ? `\n${step.description}` : ""}\nEnter a ${
        step.integer ? "integer" : "number"
      }:`;
      const text = await askMcpText(ctx, sessionId, body, signal);
      if (text === "decline" || text === "cancel") return text;
      try {
        return parseNumberAnswer(text, step.integer);
      } catch (e) {
        await ctx.reply(e instanceof Error ? e.message : String(e));
        return collectFormStep(ctx, step, formMessage, serverLabel, signal);
      }
    }
    case "string_enum": {
      const spec: Question = {
        question: step.title,
        header: step.fieldName.slice(0, 12),
        options: step.options.map((o) => ({ label: o.label, description: o.value })),
      };
      const answer = await askSingleSelect(ctx, spec, sessionId, 0, 1, signal);
      const match = step.options.find((o) => o.label === answer || o.value === answer);
      return match?.value ?? answer;
    }
    case "array_enum": {
      const spec: Question = {
        question: step.title,
        header: step.fieldName.slice(0, 12),
        options: step.options.map((o) => ({ label: o.label, description: o.value })),
        multiSelect: true,
      };
      const answer = await askMultiSelect(ctx, spec, sessionId, 0, 1, signal);
      return answer.split(", ").map((s) => {
        const match = step.options.find((o) => o.label === s);
        return match?.value ?? s;
      });
    }
    case "string_free": {
      const body = `${prefix}*${step.title}*${step.description ? `\n${step.description}` : ""}\nType your answer:`;
      const text = await askMcpText(ctx, sessionId, body, signal);
      if (text === "decline" || text === "cancel") return text;
      if (!text && step.required) {
        await ctx.reply("This field is required.");
        return collectFormStep(ctx, step, formMessage, serverLabel, signal);
      }
      return text || step.defaultValue || "";
    }
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unknown step: ${String(_exhaustive)}`);
    }
  }
}

async function reviewForm(
  ctx: TelegramContext,
  serverLabel: string,
  message: string,
  draft: Record<string, unknown>,
  signal: AbortSignal,
): Promise<"accept" | "edit" | "decline" | "cancel"> {
  const sessionId = nextInteractionSessionId();
  const body = `MCP server: ${serverLabel}\n${message}\n\nReview your answers:\n\`\`\`\n${
    formatElicitationReview(draft)
  }\n\`\`\``;
  const result = await askMcpChoice(
    ctx,
    sessionId,
    body,
    [
      { data: `${sessionId}:${REVIEW_ACCEPT}`, label: "Accept" },
      { data: `${sessionId}:${REVIEW_EDIT}`, label: "Edit" },
      { data: `${sessionId}:${REVIEW_CANCEL}`, label: "Cancel" },
    ],
    signal,
    false,
  );
  if (result === "decline" || result === "cancel") return result;
  if (result.endsWith(REVIEW_EDIT)) return "edit";
  if (result.endsWith(REVIEW_ACCEPT)) return "accept";
  return "cancel";
}

/** Runs one MCP URL elicitation with Open/Done/Decline buttons. */
export async function interactMcpUrl(
  ctx: TelegramContext,
  request: McpUrlRequest,
  signal: AbortSignal,
): Promise<UserInteractionResult> {
  const sessionId = nextInteractionSessionId();
  const label = mcpServerLabel(request.serverId, request.serverTitle);
  const host = parseUrlHost(request.url);
  const body = `MCP server: ${label}\n${request.message}\n\nOpen: ${host}`;

  const keyboard = new InlineKeyboard()
    .url("Open", request.url)
    .row()
    .text("Done", `${sessionId}:${URL_DONE}`)
    .text("Decline", `${sessionId}:${URL_DECLINE}`)
    .text("Cancel", encodeCancelCallback(sessionId));

  const result = await askMcpChoice(
    ctx,
    sessionId,
    body,
    [
      { data: `${sessionId}:${URL_DONE}`, label: "Done" },
      { data: `${sessionId}:${URL_DECLINE}`, label: "Decline" },
      { data: encodeCancelCallback(sessionId), label: "Cancel" },
    ],
    signal,
    false,
    keyboard,
  );

  if (result === "decline" || result.endsWith(URL_DECLINE)) return { action: "decline" };
  if (result === "cancel") return { action: "cancel" };
  return { action: "accept" };
}

async function askMcpChoice(
  ctx: TelegramContext,
  sessionId: number,
  body: string,
  buttons: { data: string; label: string }[],
  signal: AbortSignal,
  markdown: boolean,
  replyMarkup?: InlineKeyboard,
): Promise<string | "decline" | "cancel"> {
  const markup = replyMarkup ?? (() => {
    const kb = new InlineKeyboard();
    for (const b of buttons) kb.text(b.label, b.data).row();
    return kb;
  })();
  return await askWithAbort<string | "decline" | "cancel">(ctx, signal, ({ cleanup, resolve, reject }) => {
    const storageKey = `silas-mcp-${sessionId}`;
    return ctx
      .question(["callback_query:data"] as const)
      .getStorageKey(() => storageKey)
      .doBefore(async (beforeCtx) => {
        const text = markdown ? escapeMarkdownV2(body) : body;
        await beforeCtx.reply(text, {
          parse_mode: markdown ? "MarkdownV2" : undefined,
          reply_markup: markup,
          message_thread_id: beforeCtx.message?.message_thread_id,
        });
      })
      .filter(async (filterCtx) => {
        if (signal.aborted) return false;
        const data = filterCtx.callbackQuery?.data;
        if (!data || !data.startsWith(`${sessionId}:`) && data !== encodeCancelCallback(sessionId)) {
          if (data) await filterCtx.answerCallbackQuery({ text: "Expired." });
          return false;
        }
        return true;
      })
      .cancel(async (cancelCtx) => {
        if (cancelCtx.callbackQuery?.data === encodeCancelCallback(sessionId)) {
          await cancelCtx.answerCallbackQuery();
          reject(new UserQuestionDeclinedError());
          return true;
        }
        return false;
      })
      .thenDo(async (answerCtx) => {
        cleanup();
        await answerCtx.answerCallbackQuery();
        resolve(answerCtx.callbackQuery?.data ?? "cancel");
      });
  }).catch((error: unknown) => {
    if (error instanceof UserQuestionDeclinedError) return "decline";
    if (error instanceof UserQuestionAbortedError) return "cancel";
    throw error;
  });
}

async function askMcpText(
  ctx: TelegramContext,
  sessionId: number,
  body: string,
  signal: AbortSignal,
): Promise<string | "decline" | "cancel"> {
  return await askWithAbort<string | "decline" | "cancel">(ctx, signal, ({ cleanup, resolve, reject }) => {
    const storageKey = `silas-mcp-text-${sessionId}`;
    return ctx
      .question(["message:text", "callback_query:data"] as const)
      .getStorageKey(() => storageKey)
      .doBefore(async (beforeCtx) => {
        await beforeCtx.reply(body, { message_thread_id: beforeCtx.message?.message_thread_id });
      })
      .filter((filterCtx) => {
        if (signal.aborted) return false;
        if (filterCtx.callbackQuery?.data === encodeCancelCallback(sessionId)) return true;
        return Boolean(filterCtx.message?.text);
      })
      .cancel(async (cancelCtx) => {
        if (cancelCtx.callbackQuery?.data === encodeCancelCallback(sessionId)) {
          await cancelCtx.answerCallbackQuery();
          reject(new UserQuestionDeclinedError());
          return true;
        }
        return false;
      })
      .thenDo(async (answerCtx) => {
        cleanup();
        if (answerCtx.callbackQuery) {
          await answerCtx.answerCallbackQuery();
          resolve("decline");
          return;
        }
        resolve(answerCtx.message?.text?.trim() ?? "");
      });
  }).catch((error: unknown) => {
    if (error instanceof UserQuestionDeclinedError) return "decline";
    if (error instanceof UserQuestionAbortedError) return "cancel";
    throw error;
  });
}
