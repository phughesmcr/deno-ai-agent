import type { Tool } from "@lmstudio/sdk";
import * as path from "@std/path";
import { z } from "zod/v3";

import type { ApprovalRequest } from "../../shared/approval.ts";
import { requestForHostAwareOperation } from "./approval-support.ts";
import { displayPath, grantBrokerHostWrite, resolveHostAwarePath, type ToolContext } from "./context.ts";
import { type AgentToolDefinition, type AgentToolDeps, toolFromDefinition } from "./definitions.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";

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
  authorize: async ({ path: userPath, content }, deps): Promise<ApprovalRequest> => {
    const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(deps.workspace, userPath);
    return requestForHostAwareOperation(deps.workspace, {
      operation: "write",
      absolutePath,
      outsideWorkspace,
      display: displayPath(deps.workspace, absolutePath),
      workspaceRisk: "medium",
      summary: `write ${content.length} bytes`,
    });
  },
  run: async ({ path: userPath, content }, deps): Promise<string> => {
    const ctx = deps.workspace;
    const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
    const dir = path.dirname(absolutePath);
    const display = displayPath(ctx, absolutePath);
    if (outsideWorkspace) await grantBrokerHostWrite(absolutePath, ctx.signal);

    return await withFileMutationQueue(absolutePath, async () => {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(absolutePath, content);
      return `Successfully wrote ${content.length} bytes to ${display}`;
    });
  },
};

export function createWriteTool(ctx: ToolContext): Tool {
  return toolFromDefinition(writeToolDefinition, { workspace: ctx } as AgentToolDeps);
}
