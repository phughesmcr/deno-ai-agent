import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { resolvePath, type ToolContext } from "./context.ts";
import { withFileMutationQueue } from "./mutation-queue.ts";

const DESCRIPTION =
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";

export function createWriteTool(ctx: ToolContext): ReturnType<typeof tool> {
  return tool({
    name: "write",
    description: DESCRIPTION,
    parameters: {
      path: z.string().describe("Path to the file to write (relative or absolute)"),
      content: z.string().describe("Content to write to the file"),
    },
    implementation: async ({ path, content }) => {
      const absolutePath = await resolvePath(ctx, path);
      const dir = absolutePath.slice(0, absolutePath.lastIndexOf("/"));

      return await withFileMutationQueue(absolutePath, async () => {
        if (dir.length > 0) await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(absolutePath, content);
        return `Successfully wrote ${content.length} bytes to ${path}`;
      });
    },
  });
}
