/** Model reasoning delimiter configuration from environment. */
export interface ReasoningConfig {
  /** When false, replies pass through without parsing reasoning blocks. */
  readonly enabled: boolean;
  /** Opening tag emitted by the model before reasoning text. */
  readonly start: string;
  /** Closing tag after reasoning and before the user-visible reply. */
  readonly end: string;
}

/** LM Studio `act()` / prediction `reasoningParsing` option (see `LLMReasoningParsing`). */
export interface ActReasoningParsing {
  readonly enabled: boolean;
  readonly startString: string;
  readonly endString: string;
}

const DEFAULT_REASONING_START = "<think>";
const DEFAULT_REASONING_END = "</think>";

function reasoningEnabled(): boolean {
  const raw = Deno.env.get("REASONING_ENABLED");
  if (raw === undefined || raw === "") return true;
  return raw !== "false" && raw !== "0";
}

function reasoningTag(key: "REASONING_START" | "REASONING_END", fallback: string): string {
  const value = Deno.env.get(key);
  return value ? value : fallback;
}

/** Reads `REASONING_*` environment variables (defaults match `.env.example`). */
export function getReasoningConfig(): ReasoningConfig {
  return {
    enabled: reasoningEnabled(),
    start: reasoningTag("REASONING_START", DEFAULT_REASONING_START),
    end: reasoningTag("REASONING_END", DEFAULT_REASONING_END),
  };
}

/** `reasoningParsing` for `model.act()` — same env as Telegram reply formatting. */
export function getActReasoningParsing(): ActReasoningParsing {
  const { enabled, start, end } = getReasoningConfig();
  return { enabled, startString: start, endString: end };
}
