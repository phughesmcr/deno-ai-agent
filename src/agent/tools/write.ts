import type { Tool } from "@lmstudio/sdk";
import * as path from "@std/path";
import { z } from "zod/v3";

import type { ToolContext } from "./context.ts";
import {
  type AgentToolCapabilityRequestSpec,
  type AgentToolDefinition,
  type AgentToolDeps,
  toolFromDefinition,
} from "./definitions.ts";

const writeParameters = {
  path: z.string().describe(
    "Path to write: relative (workspace), or absolute / ~/... for host files outside the workspace",
  ),
  content: z.string().describe("Content to write to the file"),
} as const;

export const writeToolDefinition: AgentToolDefinition<typeof writeParameters> = {
  name: "write",
  description:
    "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  parameters: writeParameters,
  authorize: async ({ path: userPath, content }, deps): Promise<AgentToolCapabilityRequestSpec> => {
    const op = await deps.workspace.fs.operation({
      operation: "write",
      path: userPath,
      access: "write",
      workspaceRisk: "medium",
      summary: `write ${content.length} bytes`,
      mutationQueue: true,
    });
    return op.capabilityRequest();
  },
  run: async ({ path: userPath, content }, deps): Promise<string> => {
    const ctx = deps.workspace;
    const op = await ctx.fs.operation({
      operation: "write",
      path: userPath,
      access: "write",
      workspaceRisk: "medium",
      summary: `write ${content.length} bytes`,
      mutationQueue: true,
    });

    return await op.withAccess(async ({ absolutePath, displayPath }) => {
      const dir = path.dirname(absolutePath);
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(absolutePath, content);
      return `Successfully wrote ${content.length} bytes to ${displayPath}`;
    });
  },
};

export function createWriteTool(ctx: ToolContext): Tool {
  return toolFromDefinition(writeToolDefinition, { workspace: ctx } as AgentToolDeps);
}
