import type { Question, TurnTarget } from "../agent/mod.ts";
import type { UserInteractionRequest, UserInteractionResult } from "../agent/tools/user-interaction.ts";
import { UserQuestionAbortedError, UserQuestionDeclinedError } from "../agent/tools/user-interaction.ts";
import type { UserInteractionPort } from "../agent/tools/user-question-port.ts";
import { interactMcpForm, interactMcpUrl } from "./mcp-elicitation.ts";
import type { TelegramContext } from "./telegram.ts";
import { askMultiSelect, askSingleSelect, nextInteractionSessionId } from "./user-question-ask.ts";

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
      const sessionId = nextInteractionSessionId();
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
