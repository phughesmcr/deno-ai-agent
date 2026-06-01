import type { AskUserQuestionParams } from "./ask-user-question.ts";

/**
 * Active interaction context for the turn that invoked the model.
 * @internal
 */
export interface TurnTarget<TContext = unknown> {
  ctx: TContext;
  signal: AbortSignal;
}

/**
 * Collects structured answers from the user during a model act turn.
 * @internal
 */
export interface AskUserQuestionPort {
  isAvailable(): boolean;
  isPending(): boolean;
  setTurnContext(target: TurnTarget): void;
  clearTurnContext(): void;
  ask(params: AskUserQuestionParams): Promise<Record<string, string>>;
}

/**
 * Port for tests and non-Telegram tool registration.
 * @internal
 */
export function createUnavailableAskUserQuestionPort(): AskUserQuestionPort {
  return {
    isAvailable: () => false,
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    ask: () => Promise.reject(new Error("unreachable")),
  };
}
