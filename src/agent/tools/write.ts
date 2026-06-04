import { type Tool, tool } from "@lmstudio/sdk";
import * as path from "@std/path";
import { z } from "zod/v3";

import {
  approveHostAwareToolOperation,
  displayPath,
  grantBrokerHostWrite,
  resolveHostAwarePath,
  type ToolContext,
} from "./context.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";

export function createWriteTool(ctx: ToolContext): Tool {
  return tool({
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: {
      path: z.string().describe(
        "Path to write: relative (workspace), or absolute / ~/... for host files outside the workspace",
      ),
      content: z.string().describe("Content to write to the file"),
    },
    implementation: async ({ path: userPath, content }) => {
      const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
      const dir = path.dirname(absolutePath);
      const display = displayPath(ctx, absolutePath);
      await approveHostAwareToolOperation(ctx, {
        operation: "write",
        absolutePath,
        outsideWorkspace,
        display,
        workspaceRisk: "medium",
        summary: `write ${content.length} bytes`,
      });
      if (outsideWorkspace) await grantBrokerHostWrite(absolutePath, ctx.signal);

      return await withFileMutationQueue(absolutePath, async () => {
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(absolutePath, content);
        return `Successfully wrote ${content.length} bytes to ${display}`;
      });
    },
  });
}
