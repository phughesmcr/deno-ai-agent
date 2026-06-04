import { z } from "zod/v3";

const brokerRequestSchema = z.object({
  v: z.number(),
  pid: z.number(),
  id: z.number(),
  datetime: z.string(),
  permission: z.string().min(1),
  value: z.union([z.string(), z.null(), z.undefined()]).transform((value) => value ?? null),
});

const brokerResponseSchema = z.object({
  id: z.number(),
  result: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
});

/** Deno permission broker request (v1). */
export type BrokerRequest = z.infer<typeof brokerRequestSchema>;

/** Deno permission broker response. */
export type BrokerResponse = z.infer<typeof brokerResponseSchema>;

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
  return brokerRequestSchema.parse(JSON.parse(line.trim()));
}

/** Serializes a broker response line (includes trailing newline). */
export function formatBrokerResponse(response: BrokerResponse): string {
  return `${JSON.stringify(brokerResponseSchema.parse(response))}\n`;
}
