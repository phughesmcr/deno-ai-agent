/** Deno permission broker request (v1). */
export interface BrokerRequest {
  v: number;
  pid: number;
  id: number;
  datetime: string;
  permission: string;
  value: string | null;
}

/** Deno permission broker response. */
export interface BrokerResponse {
  id: number;
  result: "allow" | "deny";
  reason?: string;
}

/** Policy decision before human escalation. */
export type PolicyDecision = "auto_allow" | "auto_deny" | "prompt";

/**
 * Normalizes broker `value` strings (Deno may JSON-encode paths).
 * @internal
 */
export function normalizeBrokerValue(value: string | null): string | null {
  if (value === null) return null;
  let current = value.trim();
  if (current.startsWith('"') && current.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(current);
      if (typeof parsed === "string") current = parsed;
    } catch {
      current = current.slice(1, -1);
    }
  }
  return current;
}

/** Parses one JSONL broker request line. */
export function parseBrokerRequest(line: string): BrokerRequest {
  const parsed: unknown = JSON.parse(line.trim());
  if (!parsed || typeof parsed !== "object") throw new Error("invalid broker request");
  const record = parsed as Record<string, unknown>;
  return {
    v: Number(record["v"]),
    pid: Number(record["pid"]),
    id: Number(record["id"]),
    datetime: String(record["datetime"]),
    permission: String(record["permission"]),
    value: record["value"] === null || record["value"] === undefined ? null : String(record["value"]),
  };
}

/** Serializes a broker response line (includes trailing newline). */
export function formatBrokerResponse(response: BrokerResponse): string {
  return `${JSON.stringify(response)}\n`;
}
