import type { Client } from "@modelcontextprotocol/sdk/client";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../agent/tools/truncate.ts";

export interface McpResourceSummary {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Lists resources from a connected MCP server. */
export async function listMcpResources(client: Client): Promise<McpResourceSummary[]> {
  const caps = client.getServerCapabilities();
  if (!caps?.resources) return [];
  const result = await client.listResources();
  return result.resources.map((r) => ({
    uri: r.uri,
    name: r.name,
    description: r.description,
    mimeType: r.mimeType,
  }));
}

/** Reads a resource and returns text for the model. */
export async function readMcpResourceText(client: Client, uri: string): Promise<string> {
  const result = await client.readResource({ uri });
  const parts: string[] = [];
  for (const block of result.contents) {
    if ("text" in block && typeof block.text === "string") {
      const truncation = truncateHead(block.text);
      parts.push(truncation.content);
      if (truncation.truncated) {
        parts.push(`[Truncated at ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes]`);
      }
    } else if ("blob" in block && typeof block.blob === "string") {
      parts.push(`[Binary blob: ${block.blob.length} base64 chars]`);
    }
  }
  return parts.join("\n\n") || "(empty resource)";
}

/** Builds a system-prompt appendix listing MCP resources. */
export function formatResourcesAppendix(serverId: string, resources: McpResourceSummary[]): string {
  if (resources.length === 0) return "";
  const lines = resources.map((r) =>
    `- ${serverId} ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ""}: ${r.description ?? r.name ?? ""}`
  );
  return `\n## MCP resources (${serverId})\n${lines.join("\n")}\n`;
}
