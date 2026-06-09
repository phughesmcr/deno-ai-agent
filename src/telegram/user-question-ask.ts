import type { Filter } from "grammy";
import type { Question as GrammyQuestion } from "grammy-questions";

import type { Question } from "../agent/mod.ts";
import { UserQuestionAbortedError, UserQuestionDeclinedError } from "../agent/tools/user-interaction.ts";
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

/** Allocates a process-unique session id for one interaction prompt. */
export function nextInteractionSessionId(): number {
  return nextSessionId++;
}

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

/** Hooks handed to an ask builder so it can settle the surrounding promise. */
export interface AskWithAbortBuilders<T> {
  cleanup: () => void;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** Runs one grammy-questions ask with shared abort and cleanup scaffolding. */
export function askWithAbort<T>(
  ctx: TelegramContext,
  signal: AbortSignal,
  buildQuestion: (builders: AskWithAbortBuilders<T>) => unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      ctx.cancelQuestions();
      reject(new UserQuestionAbortedError());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };

    const question = buildQuestion({ cleanup, resolve, reject });

    void ctx.ask(question as GrammyQuestion<TelegramContext, never>).catch((error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/** Asks one single-select question with an inline keyboard and optional free-text answer. */
export async function askSingleSelect(
  ctx: TelegramContext,
  spec: Question,
  sessionId: number,
  index: number,
  total: number,
  signal: AbortSignal,
): Promise<string> {
  return await askWithAbort(ctx, signal, ({ cleanup, resolve, reject }) => {
    let otherMode = false;
    const storageKey = `silas-act-${sessionId}`;

    return ctx
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
        cleanup();
        if (answerCtx.callbackQuery?.data) await answerCtx.answerCallbackQuery();
        try {
          if (answerCtx.callbackQuery?.message) {
            await answerCtx.editMessageReplyMarkup({ reply_markup: undefined });
          }
        } catch { /* ignore */ }
        resolve(extractAnswerFromContext(answerCtx, spec));
      });
  });
}

/** Asks one multi-select question with a toggling inline keyboard. */
export async function askMultiSelect(
  ctx: TelegramContext,
  spec: Question,
  sessionId: number,
  index: number,
  total: number,
  signal: AbortSignal,
): Promise<string> {
  return await askWithAbort(ctx, signal, ({ cleanup, resolve, reject }) => {
    const selected = new Set<number>();
    const labels = spec.options.map((o) => o.label);
    const storageKey = `silas-act-${sessionId}`;
    let promptMessageId: number | undefined;

    const refreshKeyboard = async (
      editCtx: Filter<TelegramContext, "callback_query:data">,
    ): Promise<void> => {
      if (promptMessageId === undefined) return;
      await editCtx.editMessageReplyMarkup({
        reply_markup: buildMultiSelectKeyboard(sessionId, labels, selected),
      });
    };

    return ctx
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
          cleanup();
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
  });
}
