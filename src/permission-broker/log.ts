const encoder = new TextEncoder();

function writeStderr(line: string): void {
  Deno.stderr.writeSync(encoder.encode(`${line}\n`));
}

/** Broker-local thrown-value formatter. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Broker-local debug logger to keep the broker package independent. */
export function logDebug(message: string, fields?: Record<string, number | string>): void {
  if (Deno.env.get("LOG_LEVEL") !== "debug") return;
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  writeStderr(line);
}

/** Broker-local operational error logger. */
export function logError(message: string, fields?: Record<string, number | string>): void {
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  writeStderr(line);
}
