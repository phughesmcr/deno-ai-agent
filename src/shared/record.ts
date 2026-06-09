/** Returns true when value is a non-null object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Returns a record payload or undefined when value is not a non-null object. */
export function objectPayload(payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  return payload;
}
