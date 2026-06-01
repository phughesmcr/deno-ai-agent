import { tool } from "@lmstudio/sdk";
import * as path from "@std/path";
import { z } from "zod/v3";

import { approveToolOperation, displayPath, resolveDirectoryPath, type ToolContext } from "./context.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 500;

export function createLsTool(ctx: ToolContext): unknown {
  return tool({
    name: "ls",
    description:
      `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${
        DEFAULT_MAX_BYTES / 1024
      }KB (whichever is hit first).`,
    parameters: {
      path: z.string().optional().describe("Directory to list (default: workspace root)"),
      limit: z.number().optional().describe(`Maximum number of entries to return (default: ${DEFAULT_LIMIT})`),
    },
    implementation: async ({ path: userPath, limit }) => {
      const dirPath = await resolveDirectoryPath(ctx, userPath ?? ".");
      const effectiveLimit = limit ?? DEFAULT_LIMIT;
      await approveToolOperation(ctx, {
        operation: "list",
        target: displayPath(ctx, dirPath),
        risk: "low",
        summary: `list directory, limit=${effectiveLimit}`,
      });

      const entries: string[] = [];
      for await (const entry of Deno.readDir(dirPath)) {
        const fullPath = path.join(dirPath, entry.name);
        let suffix = "";
        try {
          const stat = await Deno.stat(fullPath);
          if (stat.isDirectory) suffix = "/";
        } catch {
          continue;
        }
        entries.push(entry.name + suffix);
      }

      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const limitedEntries = entries.slice(0, effectiveLimit);

      if (limitedEntries.length === 0) return "(empty directory)";

      const entryLimitReached = entries.length > effectiveLimit;
      const rawOutput = limitedEntries.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      }
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return output;
    },
  });
}
