import { z } from "zod/v3";

/** Builds LM Studio tool parameters from MCP JSON Schema properties (loose typing). */
export function mcpToolParametersFromSchema(
  inputSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const props = inputSchema["properties"];
  const out: Record<string, z.ZodTypeAny> = {};
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const key of Object.keys(props as Record<string, unknown>)) {
      out[key] = z.unknown().describe(`MCP field: ${key}`);
    }
  }
  if (Object.keys(out).length === 0) {
    out["input"] = z.record(z.unknown()).optional().describe("Tool arguments object");
  }
  return out;
}
