import type { Client } from "@modelcontextprotocol/sdk/client";

export interface McpPromptSummary {
  name: string;
  description?: string;
}

/** Lists prompts from a connected MCP server. */
export async function listMcpPrompts(client: Client): Promise<McpPromptSummary[]> {
  const caps = client.getServerCapabilities();
  if (!caps?.prompts) return [];
  const result = await client.listPrompts();
  return result.prompts.map((p) => ({ name: p.name, description: p.description }));
}

/** Fetches a prompt and formats messages as text for the model. */
export async function getMcpPromptText(
  client: Client,
  name: string,
  args: Record<string, string>,
): Promise<string> {
  const result = await client.getPrompt({ name, arguments: args });
  const lines: string[] = [];
  for (const msg of result.messages) {
    const role = msg.role;
    if (msg.content.type === "text") {
      lines.push(`[${role}] ${msg.content.text}`);
    } else {
      lines.push(`[${role}] (${msg.content.type} content)`);
    }
  }
  return lines.join("\n\n");
}

/** Builds a system-prompt appendix listing MCP prompts. */
export function formatPromptsAppendix(serverId: string, prompts: McpPromptSummary[]): string {
  if (prompts.length === 0) return "";
  const lines = prompts.map((p) => `- ${serverId}/${p.name}: ${p.description ?? "(no description)"}`);
  return `\n## MCP prompts (${serverId})\n${lines.join("\n")}\n`;
}
