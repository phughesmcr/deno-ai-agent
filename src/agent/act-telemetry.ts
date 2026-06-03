import { context, metrics, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

import type { ModelActObserver } from "./context/session.ts";
import { SERVICE_NAME, SERVICE_VERSION, type TelemetryAttributes } from "../shared/otel.ts";

const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
const meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);

const lmstudioActDurationMs = meter.createHistogram("lmstudio.act.duration", {
  description: "Duration of model.act",
  unit: "ms",
});

const noopModelActObserver: ModelActObserver = {
  onMessage(): void {},
  onFirstToken(): void {},
  onRoundStart(): void {},
  onRoundEnd(): void {},
  onToolCallRequestStart(): void {},
  onToolCallRequestNameReceived(): void {},
  onToolCallRequestEnd(): void {},
  onToolCallRequestFailure(): void {},
  onToolCallRequestFinalized(): void {},
  onToolCallRequestDequeued(): void {},
};

/** Buckets token counts for low-cardinality model-turn telemetry attributes. */
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

/** Records `model.act` duration when inference ran. */
export function recordActDuration(ms: number, outcome: "error" | "ok"): void {
  if (ms > 0) lmstudioActDurationMs.record(ms, { outcome });
}

/** Creates telemetry hooks for the session-owned `model.act()` lifecycle. */
export function createModelActObserver(): ModelActObserver {
  const parentSpan = trace.getActiveSpan();
  if (!parentSpan) return noopModelActObserver;

  const roundSpans = new Map<number, Span>();
  const toolCallSpans = new Map<number, Span>();

  const addEvent = (name: string, attributes?: TelemetryAttributes): void => {
    parentSpan.addEvent(name, attributes);
  };

  const startChild = (
    name: string,
    attributes?: TelemetryAttributes,
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
      const attributes: TelemetryAttributes = { "round.index": roundIndex };
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
      const attributes: TelemetryAttributes = {
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
