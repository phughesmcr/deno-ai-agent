import { traceEvent } from "./otel.ts";

const encoder = new TextEncoder();

function writeStderr(line: string): void {
  Deno.stderr.writeSync(encoder.encode(`${line}\n`));
}

/** Logs an operational event to stderr and the active OTEL span. */
export function logInfo(message: string, fields?: Record<string, number | string>): void {
  traceEvent(message, fields);
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  writeStderr(line);
}

/** Logs an operational error to stderr and the active OTEL span. */
export function logError(message: string, fields?: Record<string, number | string>): void {
  traceEvent(message, fields);
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  writeStderr(line);
}

/** Logs when `LOG_LEVEL=debug` (avoids noisy stdout and satisfies no-console in normal runs). */
export function logDebug(message: string, fields?: Record<string, number | string>): void {
  if (Deno.env.get("LOG_LEVEL") !== "debug") return;
  traceEvent(message, fields);
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  writeStderr(line);
}
