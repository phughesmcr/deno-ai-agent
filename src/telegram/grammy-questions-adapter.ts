import type { Filter } from "grammy";

import { logDebug } from "../log.ts";
import { escapeMarkdownV2 } from "../markdown.ts";
import {
  type AskUserQuestionParams,
  type Question,
  UserQuestionAbortedError,
  UserQuestionDeclinedError,
} from "../tools/ask-user-question.ts";
import type { AskUserQuestionPort, TurnTarget } from "../tools/user-question-port.ts";
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

function questionBodyText(spec: Question, index: number, total: number): string {
  const header = total > 1 ? `Question ${index + 1} of ${total}:\n\n` : "Please answer the following question:\n\n";
  const bullets = spec.options.map((o) => `- ${o.label}: ${o.description}`).join("\n");
  return `${header}${spec.question}\n\n${bullets}`;
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

/**
 * Telegram port using grammy-questions for blocking Q&A inside model.act().
 * @internal
 */
export function createTelegramAskUserQuestionPort(): AskUserQuestionPort {
  let turn: TurnTarget<TelegramContext> | undefined;
  let pending = false;

  const port: AskUserQuestionPort = {
    isAvailable: () => true,
    isPending: () => pending,
    setTurnContext(target: TurnTarget<TelegramContext>): void {
      turn = target;
    },
    clearTurnContext(): void {
      turn = undefined;
    },
    async ask(params: AskUserQuestionParams): Promise<Record<string, string>> {
      if (!turn) {
        throw new Error("No active Telegram turn context");
      }
      const { ctx, signal } = turn;
      pending = true;
      const answers: Record<string, string> = {};
      const abortHandler = (): void => {
        ctx.cancelQuestions();
      };
      signal.addEventListener("abort", abortHandler, { once: true });

      try {
        await params.questions.reduce(async (previous, spec, i) => {
          await previous;
          if (!spec) return;
          const sessionId = nextSessionId++;
          logDebug("user_question.sent", { sessionId, index: i, header: spec.header });

          if (spec.multiSelect) {
            answers[String(i)] = await askMultiSelect(ctx, spec, sessionId, i, params.questions.length, signal);
          } else {
            answers[String(i)] = await askSingleSelect(ctx, spec, sessionId, i, params.questions.length, signal);
          }
          logDebug("user_question.answered", { sessionId, index: i });
        }, Promise.resolve());

        return answers;
      } finally {
        signal.removeEventListener("abort", abortHandler);
        pending = false;
      }
    },
  };

  return port;
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
            return data === encodeOtherCallback(sessionId) ||
              parseOptionIndex(data) >= 0;
          }
          await filterCtx.answerCallbackQuery({ text: "This question has expired." });
          logDebug("user_question.stale_callback", { data });
          return false;
        }
        if (otherMode && filterCtx.message?.text) {
          return true;
        }
        return false;
      })
      .cancel(async (cancelCtx) => {
        if (cancelCtx.callbackQuery?.data === encodeCancelCallback(sessionId)) {
          await cancelCtx.answerCallbackQuery();
          try {
            await cancelCtx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch {
            /* message may be gone */
          }
          logDebug("user_question.declined", { sessionId });
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
        if (answerCtx.callbackQuery?.data) {
          await answerCtx.answerCallbackQuery();
        }
        try {
          if (answerCtx.callbackQuery?.message) {
            await answerCtx.editMessageReplyMarkup({ reply_markup: undefined });
          }
        } catch {
          /* ignore */
        }
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
          logDebug("user_question.stale_callback", { data });
          return false;
        }
        return data === encodeDoneCallback(sessionId) || parseToggleIndex(data) >= 0;
      })
      .cancel(async (cancelCtx) => {
        if (cancelCtx.callbackQuery?.data === encodeCancelCallback(sessionId)) {
          await cancelCtx.answerCallbackQuery();
          try {
            await cancelCtx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch {
            /* ignore */
          }
          logDebug("user_question.declined", { sessionId });
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
            await repeatCtx.answerCallbackQuery({
              text: "Select at least one option",
              show_alert: true,
            });
            return false;
          }
          try {
            await repeatCtx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch {
            /* ignore */
          }
          signal.removeEventListener("abort", onAbort);
          const answer = [...selected].sort((a, b) => a - b).map((i) => labels[i] ?? "").join(", ");
          resolve(answer);
          return true;
        }

        const toggleIdx = parseToggleIndex(data);
        if (toggleIdx >= 0) {
          if (selected.has(toggleIdx)) {
            selected.delete(toggleIdx);
          } else {
            selected.add(toggleIdx);
          }
          await refreshKeyboard(repeatCtx);
        }
        return false;
      })
      .thenDo(async () => {
        /* completion handled in repeatUntil */
      });

    void ctx.ask(question).catch((error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
