import type { Client } from "@modelcontextprotocol/sdk/client";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types";

import type { McpRequestedSchema } from "../agent/tools/user-interaction.ts";
import type { UserInteractionPort, UserInteractionResult } from "../agent/tools/user-question-port.ts";
import { type ElicitationGate, gatedInteractionPort } from "./parallel.ts";

function mcpResultToElicitationResponse(result: UserInteractionResult): {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
} {
  if (result.action === "accept") {
    return result.content !== undefined ? { action: "accept", content: result.content } : { action: "accept" };
  }
  return { action: result.action };
}

/** Registers elicitation/create on the MCP client. Phase 1: decline; Phase 2: full port. */
export function registerElicitationHandler(
  client: Client,
  port: UserInteractionPort,
  spec: { enabled: boolean; serverId: string; serverTitle?: string },
  gate: ElicitationGate,
): void {
  const effectivePort = gatedInteractionPort(port, gate);

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    if (!spec.enabled) {
      return { action: "decline" as const };
    }

    const mode = request.params.mode ?? "form";
    if (mode === "url") {
      const params = request.params as {
        message: string;
        url: string;
        elicitationId: string;
      };
      const result = await effectivePort.interact({
        mode: "mcp_url",
        message: params.message,
        url: params.url,
        elicitationId: params.elicitationId,
        serverId: spec.serverId,
        serverTitle: spec.serverTitle,
      });
      return mcpResultToElicitationResponse(result);
    }

    if (mode === "form" || mode === undefined) {
      const params = request.params as {
        message: string;
        requestedSchema: McpRequestedSchema;
      };
      const result = await effectivePort.interact({
        mode: "mcp_form",
        message: params.message,
        requestedSchema: params.requestedSchema,
        serverId: spec.serverId,
        serverTitle: spec.serverTitle,
      });
      return mcpResultToElicitationResponse(result);
    }

    return { action: "decline" as const };
  });
}
