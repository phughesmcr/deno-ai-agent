import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { withRecoverableToolErrors } from "../agent/tools/tool-errors.ts";
import { formatMcpToolName } from "./naming.ts";
import { mcpToolParametersFromSchema } from "./schema-params.ts";

const DESCRIPTION_MAX = 500;

export interface McpListedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CreateLmToolsSpec {
  serverId: string;
  transport: "http" | "stdio";
  tools: McpListedTool[];
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}

function truncateDescription(text: string | undefined, serverId: string, transport: string): string {
  const base = text?.trim() || "(no description)";
  const prefix = `[MCP ${serverId}/${transport}] `;
  const full = prefix + base;
  if (full.length <= DESCRIPTION_MAX) return full;
  return full.slice(0, DESCRIPTION_MAX - 3) + "...";
}

/** Maps MCP tools to LM Studio tools for one server. */
export function createLmToolsForServer(spec: CreateLmToolsSpec): Tool[] {
  return spec.tools.map((mcpTool) => {
    const lmName = formatMcpToolName(spec.serverId, mcpTool.name);
    return withRecoverableToolErrors(
      tool({
        name: lmName,
        description: truncateDescription(mcpTool.description, spec.serverId, spec.transport),
        parameters: mcpToolParametersFromSchema(mcpTool.inputSchema),
        implementation: async (params, toolCtx) => {
          const signal = (toolCtx as { signal?: AbortSignal } | undefined)?.signal;
          return await spec.callTool(mcpTool.name, params as Record<string, unknown>, signal);
        },
      }),
    );
  });
}

/** Meta-tool: prompts/get */
export function createGetPromptTool(
  serverId: string,
  transport: "http" | "stdio",
  getPrompt: (name: string, args: Record<string, string>) => Promise<string>,
): Tool {
  return withRecoverableToolErrors(
    tool({
      name: formatMcpToolName(serverId, "mcp_get_prompt"),
      description: truncateDescription("Fetch an MCP prompt template by name.", serverId, transport),
      parameters: {
        name: z.string().describe("Prompt name from the MCP server."),
        arguments: z.record(z.string()).optional().describe("Prompt arguments."),
      },
      implementation: async ({ name, arguments: promptArgs }) => {
        return await getPrompt(name, promptArgs ?? {});
      },
    }),
  );
}

/** Meta-tool: resources/read */
export function createReadResourceTool(
  serverId: string,
  transport: "http" | "stdio",
  readResource: (uri: string) => Promise<string>,
): Tool {
  return withRecoverableToolErrors(
    tool({
      name: formatMcpToolName(serverId, "mcp_read_resource"),
      description: truncateDescription("Read an MCP resource by URI.", serverId, transport),
      parameters: {
        uri: z.string().describe("Resource URI from the MCP catalog."),
      },
      implementation: async ({ uri }) => await readResource(uri),
    }),
  );
}
