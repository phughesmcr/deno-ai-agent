import { context, type Span, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

export const SERVICE_NAME = "deno-ai-agent";
export const SERVICE_VERSION = "0.0.1";

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Record<string, TelemetryAttributeValue>;

const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);

/** Options for {@link traceSpan}. */
export interface TraceSpanOptions {
  /** Span attributes set at creation. */
  attributes?: TelemetryAttributes;
  /** When true, starts a new trace (not linked to long-poll / startup context). */
  root?: boolean;
}

/** Minimal span surface passed to {@link traceSpan} callbacks. */
export interface TraceSpanHandle {
  /** Sets a single span attribute. */
  setAttribute(key: string, value: TelemetryAttributeValue): void;
  /** Sets multiple span attributes. */
  setAttributes(attributes: TelemetryAttributes): void;
}

function asHandle(span: Span): TraceSpanHandle {
  return {
    setAttribute: (key, value) => span.setAttribute(key, value),
    setAttributes: (attributes) => span.setAttributes(attributes),
  };
}

function errorForTelemetry(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Records an instant event on the active span (no-op when none is active). */
export function traceEvent(name: string, attributes?: TelemetryAttributes): void {
  trace.getActiveSpan()?.addEvent(name, attributes);
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
          const recordedError = errorForTelemetry(error);
          span.recordException(recordedError);
          span.setStatus({ code: SpanStatusCode.ERROR, message: recordedError.message });
          throw error;
        } finally {
          span.end();
        }
      }),
  );
}
