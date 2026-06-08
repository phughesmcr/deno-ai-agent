/**
 * Model reasoning delimiters and persistence policy.
 *
 * Invariant: only `TurnRunner` `replyTexts` uses raw assistant text for adapter egress.
 * Durable session events, compaction checkpoints, and subagent results use `persistedModelText` /
 * `chatMessageForPersistence` so `KEEP_THINKING=false` strips reasoning before save.
 *
 * `REASONING_ACT_PARSING` controls LM Studio `model.act()` `reasoningParsing` (default off).
 */

/** Model reasoning delimiter configuration from environment. */
export interface ReasoningConfig {
  /** When false, replies pass through without parsing reasoning blocks. */
  readonly enabled: boolean;
  /** Opening tag emitted by the model before reasoning text. */
  readonly start: string;
  /** Closing tag after reasoning and before the user-visible reply. */
  readonly end: string;
  /** When false, strip reasoning from persisted model text (session, compaction, subagents). */
  readonly keepThinking: boolean;
}

/** LM Studio `act()` / prediction `reasoningParsing` option (see `LLMReasoningParsing`). */
export interface ActReasoningParsing {
  readonly enabled: boolean;
  readonly startString: string;
  readonly endString: string;
}

const DEFAULT_REASONING_START = "<think>";
const DEFAULT_REASONING_END = "</think>";

function stripReasoningTags(text: string, start: string, end: string): string {
  return text.replaceAll(start, "").replaceAll(end, "").trim();
}

/** Reads `REASONING_*` and `KEEP_THINKING` environment variables (defaults match `.env.example`). */
export function getReasoningConfig(): ReasoningConfig {
  const env = loadReasoningEnvConfig();
  return {
    enabled: env.REASONING_ENABLED,
    start: env.REASONING_START || DEFAULT_REASONING_START,
    end: env.REASONING_END || DEFAULT_REASONING_END,
    keepThinking: env.KEEP_THINKING,
  };
}

/**
 * Removes model reasoning blocks; returns plain user-visible text.
 * When `REASONING_ENABLED=false`, only trims (no delimiter parsing).
 */
export function stripReasoningFromText(message: string): string {
  const { enabled, start, end } = getReasoningConfig();
  if (!enabled) return message.trim();

  const closeIndex = message.indexOf(end);
  if (closeIndex === -1) return stripReasoningTags(message, start, end);
  return message.slice(closeIndex + end.length).trim();
}

/** Text to store in session, compaction, or subagent results (respects `KEEP_THINKING`). */
export function persistedModelText(text: string): string {
  const { keepThinking } = getReasoningConfig();
  return keepThinking ? text : stripReasoningFromText(text);
}

/**
 * `reasoningParsing` for `model.act()` when `REASONING_ACT_PARSING` (or `REASONING_ENABLED` when unset) is true.
 * Returns `undefined` for models whose LM Studio prompt template does not support reasoning (e.g. Gemma).
 */
export function getActReasoningParsing(): ActReasoningParsing | undefined {
  if (!loadReasoningEnvConfig().REASONING_ACT_PARSING) return undefined;
  const { enabled, start, end } = getReasoningConfig();
  if (!enabled) return undefined;
  return { enabled: true, startString: start, endString: end };
}

/** Spread into `model.act()` options; omits `reasoningParsing` when act-time parsing is disabled. */
export function actReasoningParsingOption(): { readonly reasoningParsing: ActReasoningParsing } | undefined {
  const reasoningParsing = getActReasoningParsing();
  return reasoningParsing ? { reasoningParsing } : undefined;
}
import { loadReasoningEnvConfig } from "./config.ts";
