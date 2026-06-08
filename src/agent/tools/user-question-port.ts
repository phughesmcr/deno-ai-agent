import type { UserInteractionRequest, UserInteractionResult } from "./user-interaction.ts";
import { UserQuestionAbortedError, UserQuestionDeclinedError } from "./user-interaction.ts";

export type { UserInteractionRequest, UserInteractionResult } from "./user-interaction.ts";

/**
 * Active interaction context for the turn that invoked the model.
 * @internal
 */
export interface TurnTarget<TContext = unknown> {
  ctx: TContext;
  signal: AbortSignal;
}

/**
 * Collects structured answers from the user during a model act turn (Cursor questions + MCP elicitation).
 * @internal
 */
export interface UserInteractionPort {
  isAvailable(): boolean;
  isPending(): boolean;
  setTurnContext(target: TurnTarget): void;
  clearTurnContext(): void;
  interact(request: UserInteractionRequest): Promise<UserInteractionResult>;
  /** Resolves when the server sends elicitation/complete for URL flows. */
  waitForUrlElicitationComplete?(elicitationId: string, signal: AbortSignal): Promise<void>;
  /** Called by MCP notification handler when URL elicitation completes. */
  notifyUrlElicitationComplete?(elicitationId: string): void;
}

/**
 * Port for tests and non-Telegram tool registration.
 * @internal
 */
export function createUnavailableUserInteractionPort(): UserInteractionPort {
  return {
    isAvailable: () => false,
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    interact: () => Promise.reject(new Error("unreachable")),
  };
}

/** Maps a cursor_questions interaction result to the model-visible answers record. */
export function cursorQuestionsToAnswers(
  result: UserInteractionResult,
  questionCount: number,
): Record<string, string> {
  if (result.action === "decline") throw new UserQuestionDeclinedError();
  if (result.action === "cancel") throw new UserQuestionAbortedError();
  const out: Record<string, string> = {};
  const content = result.content ?? {};
  for (let i = 0; i < questionCount; i++) {
    const v = content[String(i)];
    if (v !== undefined) out[String(i)] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}
