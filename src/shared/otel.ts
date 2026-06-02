import { context, metrics, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

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
  if (count < 2_000) return "1k_2k";
  if (count < 4_000) return "2k_4k";
  if (count < 8_000) return "4k_8k";
  if (count < 16_000) return "8k_16k";
  if (count < 32_000) return "16k_32k";
  if (count < 64_000) return "32k_64k";
  if (count < 128_000) return "64k_128k";
  return "gte_128k";
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

/** Records an instant event on the active span (no-op when none is active). */
export function traceEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
}

/** Tracks child spans and events for `model.act()` lifecycle callbacks. */
export interface ActSpanTracker {
  /** Records an assistant message event. */
  onMessage(): void;
  /** Records time to first token for a round. */
  onFirstToken(roundIndex: number, ms?: number): void;
  /** Starts a span for an act round. */
  onRoundStart(roundIndex: number): void;
  /** Ends the span for an act round. */
  onRoundEnd(roundIndex: number): void;
  /** Starts a span when the model requests a tool call. */
  onToolCallRequestStart(roundIndex: number, callId: number, toolCallId?: string): void;
  /** Records the resolved tool name for a pending call. */
  onToolCallRequestNameReceived(callId: number, name: string): void;
  /** Records that a tool call request finished streaming. */
  onToolCallRequestEnd(roundIndex: number, callId: number, name: string, isQueued: boolean): void;
  /** Ends a tool call span after a request failure. */
  onToolCallRequestFailure(callId: number, message: string): void;
  /** Ends a tool call span after the request is finalized. */
  onToolCallRequestFinalized(callId: number, name: string): void;
  /** Records that a queued tool call started executing. */
  onToolCallRequestDequeued(roundIndex: number, callId: number): void;
}

const noopActSpanTracker: ActSpanTracker = {
  onMessage() {},
  onFirstToken() {},
  onRoundStart() {},
  onRoundEnd() {},
  onToolCallRequestStart() {},
  onToolCallRequestNameReceived() {},
  onToolCallRequestEnd() {},
  onToolCallRequestFailure() {},
  onToolCallRequestFinalized() {},
  onToolCallRequestDequeued() {},
};

/** Creates a tracker for lmstudio `act()` `on*` callbacks under the active `lmstudio.act` span. */
export function createActSpanTracker(): ActSpanTracker {
  const parentSpan = trace.getActiveSpan();
  if (!parentSpan) return noopActSpanTracker;

  const roundSpans = new Map<number, Span>();
  const toolCallSpans = new Map<number, Span>();

  const addEvent = (name: string, attributes?: Record<string, string | number | boolean>): void => {
    parentSpan.addEvent(name, attributes);
  };

  const startChild = (
    name: string,
    attributes?: Record<string, string | number | boolean>,
    roundIndex?: number,
  ): Span => {
    const parent = roundIndex !== undefined && roundSpans.has(roundIndex) ? roundSpans.get(roundIndex)! : parentSpan;
    const ctx = trace.setSpan(context.active(), parent);
    return tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes }, ctx);
  };

  const endSpan = (span: Span | undefined, error?: Error): void => {
    if (!span) return;
    if (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }
    span.end();
  };

  return {
    onMessage(): void {
      addEvent("lmstudio.act.message");
    },
    onFirstToken(roundIndex: number, ms?: number): void {
      const attributes: Record<string, string | number | boolean> = { "round.index": roundIndex };
      if (ms !== undefined) attributes["first_token.ms"] = Math.round(ms);
      addEvent("lmstudio.act.first_token", attributes);
    },
    onRoundStart(roundIndex: number): void {
      roundSpans.set(roundIndex, startChild("lmstudio.act.round", { "round.index": roundIndex }));
    },
    onRoundEnd(roundIndex: number): void {
      endSpan(roundSpans.get(roundIndex));
      roundSpans.delete(roundIndex);
    },
    onToolCallRequestStart(roundIndex: number, callId: number, toolCallId?: string): void {
      const attributes: Record<string, string | number | boolean> = {
        "round.index": roundIndex,
        "tool.call_id": callId,
      };
      if (toolCallId) attributes["tool.llm_call_id"] = toolCallId;
      toolCallSpans.set(callId, startChild("lmstudio.act.tool_call", attributes, roundIndex));
    },
    onToolCallRequestNameReceived(callId: number, name: string): void {
      toolCallSpans.get(callId)?.setAttribute("tool.name", name);
      addEvent("lmstudio.act.tool_call.name", { "tool.call_id": callId, "tool.name": name });
    },
    onToolCallRequestEnd(roundIndex: number, callId: number, name: string, isQueued: boolean): void {
      toolCallSpans.get(callId)?.setAttributes({ "tool.name": name, "tool.queued": isQueued });
      addEvent("lmstudio.act.tool_call.request_end", {
        "round.index": roundIndex,
        "tool.call_id": callId,
        "tool.name": name,
        "tool.queued": isQueued,
      });
    },
    onToolCallRequestFailure(callId: number, message: string): void {
      endSpan(toolCallSpans.get(callId), new Error(message));
      toolCallSpans.delete(callId);
    },
    onToolCallRequestFinalized(callId: number, name: string): void {
      toolCallSpans.get(callId)?.setAttribute("tool.name", name);
      endSpan(toolCallSpans.get(callId));
      toolCallSpans.delete(callId);
    },
    onToolCallRequestDequeued(roundIndex: number, callId: number): void {
      addEvent("lmstudio.act.tool_call.dequeued", { "round.index": roundIndex, "tool.call_id": callId });
    },
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
    (span) =>
      context.with(trace.setSpan(context.active(), span), async () => {
        try {
          return await fn(asHandle(span));
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
          throw error;
        } finally {
          span.end();
        }
      }),
  );
}
