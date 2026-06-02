/** Logs broker debug events when `LOG_LEVEL=debug`. */
export function logDebug(message: string, fields?: Record<string, number | string>): void {
  if (Deno.env.get("LOG_LEVEL") !== "debug") return;
  const line = fields ? `${message} ${JSON.stringify(fields)}` : message;
  // deno-lint-ignore no-console
  console.error(line);
}
