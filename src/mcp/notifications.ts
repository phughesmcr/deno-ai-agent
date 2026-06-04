import type { Client } from "@modelcontextprotocol/sdk/client";

import type { UserInteractionPort } from "../agent/tools/user-question-port.ts";

export interface McpNotificationHandlers {
  onToolsListChanged?: () => void;
  onResourcesListChanged?: () => void;
  onPromptsListChanged?: () => void;
}

/** Wires SDK notification handlers for MCP session events. */
export function attachMcpNotificationHandlers(
  client: Client,
  port: UserInteractionPort,
  handlers: McpNotificationHandlers,
): void {
  client.fallbackNotificationHandler = (notification) => {
    if (notification.method === "notifications/elicitation/complete") {
      const params = notification.params as { elicitationId?: string };
      if (params.elicitationId) {
        port.notifyUrlElicitationComplete?.(params.elicitationId);
      }
    } else if (notification.method === "notifications/tools/list_changed") {
      handlers.onToolsListChanged?.();
    } else if (notification.method === "notifications/resources/list_changed") {
      handlers.onResourcesListChanged?.();
    } else if (notification.method === "notifications/prompts/list_changed") {
      handlers.onPromptsListChanged?.();
    }
    return Promise.resolve();
  };
}
