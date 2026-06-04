import { type Filter, InlineKeyboard } from "grammy";

import type { Question, TurnTarget } from "../agent/mod.ts";
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
  UserInteractionRequest,
  UserInteractionResult,
} from "../agent/tools/user-interaction.ts";
import { UserQuestionAbortedError, UserQuestionDeclinedError } from "../agent/tools/user-interaction.ts";
import type { UserInteractionPort } from "../agent/tools/user-question-port.ts";
import { escapeMarkdownV2 } from "./markdown.ts";
import type { TelegramContext } from "./telegram.ts";
import {
  encodeCancelCallback,
  encodeDoneCallback,
  encodeOtherCallback,
  isSessionCallback,
  parseOptionIndex,
  parseToggleIndex,
} from "./user-question-callback.ts";
import { buildMultiSelectKeyboard, buildSingleSelectKeyboard } from "./user-question-keyboard.ts";

let nextSessionId = 1;

const REVIEW_ACCEPT = "review_accept";
const REVIEW_EDIT = "review_edit";
const REVIEW_CANCEL = "review_cancel";
const URL_DONE = "url_done";
const URL_DECLINE = "url_decline";
const BOOL_YES = "bool_yes";
const BOOL_NO = "bool_no";

function questionBodyText(spec: Question, index: number, total: number): string {
  const header = total > 1 ? `Question ${index + 1} of ${total}:\n\n` : "Please answer the following question:\n\n";
  const bullets = spec.options.map((o) => `- ${o.label}: ${o.description}`).join("\n");
  return `${header}${spec.question}\n\n${bullets}`;
}

function mcpServerLabel(serverId: string, serverTitle?: string): string {
  return serverTitle ? `${serverTitle} (${serverId})` : serverId;
}

function extractAnswerFromContext(
  ctx: Filter<TelegramContext, "callback_query:data" | "message:text">,
  spec: Question,
): string {
  if (ctx.callbackQuery?.data) {
    const idx = parseOptionIndex(ctx.callbackQuery.data);
    const option = spec.options[idx];
    if (option) return option.label;
  }
  return ctx.message?.text?.trim() ?? "";
}

function parseUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Telegram port for Cursor questions and MCP elicitation inside model.act().
 * @internal
 */
export function createTelegramUserInteractionPort(): UserInteractionPort {
  let turn: TurnTarget<TelegramContext> | undefined;
  let pending = false;
  const urlCompleteWaiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

  const port: UserInteractionPort = {
    isAvailable: () => true,
    isPending: () => pending,
    setTurnContext(target: TurnTarget<TelegramContext>): void {
      turn = target;
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    notifyUrlElicitationComplete(elicitationId: string): void {
      const waiter = urlCompleteWaiters.get(elicitationId);
      if (waiter) {
        urlCompleteWaiters.delete(elicitationId);
        waiter.resolve();
      }
    },
    waitForUrlElicitationComplete(elicitationId: string, signal: AbortSignal): Promise<void> {
      if (urlCompleteWaiters.has(elicitationId)) {
        return Promise.reject(new Error("Already waiting for elicitation"));
      }
      const wait = Promise.withResolvers<void>();
      const onAbort = (): void => {
        urlCompleteWaiters.delete(elicitationId);
        wait.reject(new UserQuestionAbortedError());
      };
      if (signal.aborted) {
        onAbort();
        return wait.promise;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      urlCompleteWaiters.set(elicitationId, {
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          wait.resolve();
        },
        reject: (e) => {
          signal.removeEventListener("abort", onAbort);
          wait.reject(e);
        },
      });
      return wait.promise;
    },
    async interact(request: UserInteractionRequest): Promise<UserInteractionResult> {
      if (!turn) throw new Error("No active Telegram turn context");
      const { ctx, signal } = turn;
      pending = true;
      try {
        switch (request.mode) {
          case "cursor_questions":
            return await interactCursorQuestions(ctx, request.questions, signal);
          case "mcp_form":
            return await interactMcpForm(ctx, request, signal);
          case "mcp_url":
            return await interactMcpUrl(ctx, request, signal);
          default: {
            const _exhaustive: never = request;
            throw new Error(`Unknown interaction mode: ${String(_exhaustive)}`);
          }
        }
      } finally {
        pending = false;
      }
    },
  };

  return port;
}

async function interactCursorQuestions(
  ctx: TelegramContext,
  questions: Question[],
  signal: AbortSignal,
): Promise<UserInteractionResult> {
  const content: Record<string, unknown> = {};
  const abortHandler = (): void => {
    ctx.cancelQuestions();
  };
  signal.addEventListener("abort", abortHandler, { once: true });
  try {
    for (let i = 0; i < questions.length; i++) {
      const spec = questions[i];
      if (!spec) continue;
      const sessionId = nextSessionId++;
      if (spec.multiSelect) {
        content[String(i)] = await askMultiSelect(ctx, spec, sessionId, i, questions.length, signal);
      } else {
        content[String(i)] = await askSingleSelect(ctx, spec, sessionId, i, questions.length, signal);
      }
    }
    return { action: "accept", content };
  } catch (error) {
    if (error instanceof UserQuestionDeclinedError) return { action: "decline" };
    if (error instanceof UserQuestionAbortedError) return { action: "cancel" };
    throw error;
  } finally {
    signal.removeEventListener("abort", abortHandler);
  }
}

async function interactMcpForm(
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
  const sessionId = nextSessionId++;

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
  const sessionId = nextSessionId++;
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

async function interactMcpUrl(
  ctx: TelegramContext,
  request: McpUrlRequest,
  signal: AbortSignal,
): Promise<UserInteractionResult> {
  const sessionId = nextSessionId++;
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
  return await new Promise<string | "decline" | "cancel">((resolve, reject) => {
    const storageKey = `silas-mcp-${sessionId}`;
    const onAbort = (): void => {
      ctx.cancelQuestions();
      reject(new UserQuestionAbortedError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const question = ctx
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
        signal.removeEventListener("abort", onAbort);
        await answerCtx.answerCallbackQuery();
        resolve(answerCtx.callbackQuery?.data ?? "cancel");
      });

    void ctx.ask(question).catch((error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
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
  return await new Promise<string | "decline" | "cancel">((resolve, reject) => {
    const storageKey = `silas-mcp-text-${sessionId}`;
    const onAbort = (): void => {
      ctx.cancelQuestions();
      reject(new UserQuestionAbortedError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const question = ctx
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
        signal.removeEventListener("abort", onAbort);
        if (answerCtx.callbackQuery) {
          await answerCtx.answerCallbackQuery();
          resolve("decline");
          return;
        }
        resolve(answerCtx.message?.text?.trim() ?? "");
      });

    void ctx.ask(question).catch((error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  }).catch((error: unknown) => {
    if (error instanceof UserQuestionDeclinedError) return "decline";
    if (error instanceof UserQuestionAbortedError) return "cancel";
    throw error;
  });
}

async function askSingleSelect(
  ctx: TelegramContext,
  spec: Question,
  sessionId: number,
  index: number,
  total: number,
  signal: AbortSignal,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let otherMode = false;
    const storageKey = `silas-act-${sessionId}`;

    const onAbort = (): void => {
      ctx.cancelQuestions();
      reject(new UserQuestionAbortedError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const question = ctx
      .question(["callback_query:data", "message:text"] as const)
      .getStorageKey(() => storageKey)
      .doBefore(async (beforeCtx) => {
        const text = escapeMarkdownV2(questionBodyText(spec, index, total));
        const labels = spec.options.map((o) => o.label);
        await beforeCtx.reply(text, {
          parse_mode: "MarkdownV2",
          reply_markup: buildSingleSelectKeyboard(sessionId, labels),
          message_thread_id: beforeCtx.message?.message_thread_id,
        });
      })
      .filter(async (filterCtx) => {
        if (signal.aborted) return false;
        if (filterCtx.callbackQuery?.data) {
          const data = filterCtx.callbackQuery.data;
          if (isSessionCallback(data, sessionId)) {
            return data === encodeOtherCallback(sessionId) || parseOptionIndex(data) >= 0;
          }
          await filterCtx.answerCallbackQuery({ text: "This question has expired." });
          return false;
        }
        if (otherMode && filterCtx.message?.text) return true;
        return false;
      })
      .cancel(async (cancelCtx) => {
        if (cancelCtx.callbackQuery?.data === encodeCancelCallback(sessionId)) {
          await cancelCtx.answerCallbackQuery();
          try {
            await cancelCtx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch { /* ignore */ }
          reject(new UserQuestionDeclinedError());
          return true;
        }
        if (cancelCtx.callbackQuery?.data === encodeOtherCallback(sessionId)) {
          await cancelCtx.answerCallbackQuery({ text: "Type your answer" });
          otherMode = true;
          return false;
        }
        return false;
      })
      .thenDo(async (answerCtx) => {
        signal.removeEventListener("abort", onAbort);
        if (answerCtx.callbackQuery?.data) await answerCtx.answerCallbackQuery();
        try {
          if (answerCtx.callbackQuery?.message) {
            await answerCtx.editMessageReplyMarkup({ reply_markup: undefined });
          }
        } catch { /* ignore */ }
        resolve(extractAnswerFromContext(answerCtx, spec));
      });

    void ctx.ask(question).catch((error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function askMultiSelect(
  ctx: TelegramContext,
  spec: Question,
  sessionId: number,
  index: number,
  total: number,
  signal: AbortSignal,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const selected = new Set<number>();
    const labels = spec.options.map((o) => o.label);
    const storageKey = `silas-act-${sessionId}`;
    let promptMessageId: number | undefined;

    const onAbort = (): void => {
      ctx.cancelQuestions();
      reject(new UserQuestionAbortedError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    const refreshKeyboard = async (
      editCtx: Filter<TelegramContext, "callback_query:data">,
    ): Promise<void> => {
      if (promptMessageId === undefined) return;
      await editCtx.editMessageReplyMarkup({
        reply_markup: buildMultiSelectKeyboard(sessionId, labels, selected),
      });
    };

    const question = ctx
      .question(["callback_query:data"] as const)
      .getStorageKey(() => storageKey)
      .doBefore(async (beforeCtx) => {
        const text = escapeMarkdownV2(questionBodyText(spec, index, total));
        const sent = await beforeCtx.reply(text, {
          parse_mode: "MarkdownV2",
          reply_markup: buildMultiSelectKeyboard(sessionId, labels, selected),
          message_thread_id: beforeCtx.message?.message_thread_id,
        });
        promptMessageId = sent.message_id;
      })
      .filter(async (filterCtx) => {
        if (signal.aborted) return false;
        const data = filterCtx.callbackQuery?.data;
        if (!data) return false;
        if (!isSessionCallback(data, sessionId)) {
          await filterCtx.answerCallbackQuery({ text: "This question has expired." });
          return false;
        }
        return data === encodeDoneCallback(sessionId) || parseToggleIndex(data) >= 0;
      })
      .cancel(async (cancelCtx) => {
        if (cancelCtx.callbackQuery?.data === encodeCancelCallback(sessionId)) {
          await cancelCtx.answerCallbackQuery();
          try {
            await cancelCtx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch { /* ignore */ }
          reject(new UserQuestionDeclinedError());
          return true;
        }
        return false;
      })
      .repeatUntil(async (repeatCtx) => {
        const data = repeatCtx.callbackQuery?.data;
        if (!data) return false;
        await repeatCtx.answerCallbackQuery();
        if (data === encodeDoneCallback(sessionId)) {
          if (selected.size === 0) {
            await repeatCtx.answerCallbackQuery({ text: "Select at least one option", show_alert: true });
            return false;
          }
          try {
            await repeatCtx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch { /* ignore */ }
          signal.removeEventListener("abort", onAbort);
          resolve([...selected].toSorted((a, b) => a - b).map((i) => labels[i] ?? "").join(", "));
          return true;
        }
        const toggleIdx = parseToggleIndex(data);
        if (toggleIdx >= 0) {
          if (selected.has(toggleIdx)) selected.delete(toggleIdx);
          else selected.add(toggleIdx);
          await refreshKeyboard(repeatCtx);
        }
        return false;
      })
      .thenDo(async () => {});

    void ctx.ask(question).catch((error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
