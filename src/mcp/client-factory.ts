import type { ClientOptions } from "@modelcontextprotocol/sdk/client";
import { Client } from "@modelcontextprotocol/sdk/client";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface CreateMcpClientOptions {
  listChanged?: ClientOptions["listChanged"];
}

/** Creates an MCP client with Silas capabilities for protocol 2025-11-25. */
export function createMcpClient(options: CreateMcpClientOptions = {}): Client {
  return new Client(
    { name: "silas", version: "0.0.1" },
    {
      capabilities: {
        elicitation: { form: {}, url: {} },
        tasks: {
          requests: {
            "elicitation/create": {},
          },
        },
      },
      listChanged: options.listChanged,
    },
  );
}
