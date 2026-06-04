import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";

/** Creates Streamable HTTP transport for a remote MCP server. */
export function createHttpTransport(url: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(url));
}
