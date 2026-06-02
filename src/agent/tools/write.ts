import { tool } from "@lmstudio/sdk";
import * as path from "@std/path";
import { z } from "zod/v3";

import { approveToolOperation, displayPath, resolvePath, type ToolContext } from "./context.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";

export function createWriteTool(ctx: ToolContext): unknown {
  return tool({
    name: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: {
      path: z.string().describe("Path to the file to write (relative or absolute, under workspace)"),
      content: z.string().describe("Content to write to the file"),
    },
    implementation: async ({ path: userPath, content }) => {
      const absolutePath = await resolvePath(ctx, userPath);
      const dir = path.dirname(absolutePath);
      const display = displayPath(ctx, absolutePath);
      await approveToolOperation(ctx, {
        operation: "write",
        target: display,
        risk: "medium",
        summary: `write ${content.length} bytes`,
      });

      return await withFileMutationQueue(absolutePath, async () => {
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(absolutePath, content);
        return `Successfully wrote ${content.length} bytes to ${display}`;
      });
    },
  });
}
