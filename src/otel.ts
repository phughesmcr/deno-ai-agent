import { metrics, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

const SERVICE_NAME = "deno-ai-agent";
const SERVICE_VERSION = "0.0.1";

const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
const meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);

const telegramMessagesTotal = meter.createCounter("telegram.messages", {
  description: "Telegram messages handled",
});

const lmstudioActDurationMs = meter.createHistogram("lmstudio.act.duration", {
  description: "Duration of model.act",
  unit: "ms",
});

/** Options for {@link traceSpan}. */
export interface TraceSpanOptions {
  /** Span attributes set at creation. */
  attributes?: Record<string, string | number | boolean>;
  /** When true, starts a new trace (not linked to long-poll / startup context). */
  root?: boolean;
}

/** Minimal span surface passed to {@link traceSpan} callbacks. */
export interface TraceSpanHandle {
  /** Sets a single span attribute. */
  setAttribute(key: string, value: string | number | boolean): void;
  /** Sets multiple span attributes. */
  setAttributes(attributes: Record<string, string | number | boolean>): void;
}

/** Buckets token counts for low-cardinality metric/span attributes. */
export function tokenBucket(count: number): string {
  if (count < 1_000) return "lt_1k";
  if (count < 8_000) return "1k_8k";
  if (count < 32_000) return "8k_32k";
  if (count < 64_000) return "32k_64k";
  return "gte_64k";
}

/** Records one handled Telegram message. */
export function recordTelegramMessage(outcome: "error" | "ok", skipped: boolean): void {
  telegramMessagesTotal.add(1, { outcome, skipped: String(skipped) });
}

/** Records `model.act` duration when inference ran. */
export function recordActDuration(ms: number, outcome: "error" | "ok"): void {
  if (ms > 0) lmstudioActDurationMs.record(ms, { outcome });
}

function asHandle(span: Span): TraceSpanHandle {
  return {
    setAttribute: (key, value) => span.setAttribute(key, value),
    setAttributes: (attributes) => span.setAttributes(attributes),
  };
}

/** Runs {@link fn} inside an active span; records errors and always ends the span. */
export function traceSpan<T>(
  name: string,
  fn: (span: TraceSpanHandle) => T | Promise<T>,
  options?: TraceSpanOptions,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { attributes: options?.attributes, root: options?.root, kind: SpanKind.INTERNAL },
    async (span) => {
      try {
        return await fn(asHandle(span));
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
