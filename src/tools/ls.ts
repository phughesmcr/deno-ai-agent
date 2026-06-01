import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { resolveDirectory, type ToolContext } from "./context.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 500;

const DESCRIPTION =
  `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${
    DEFAULT_MAX_BYTES / 1024
  }KB (whichever is hit first).`;

export function createLsTool(ctx: ToolContext): ReturnType<typeof tool> {
  return tool({
    name: "ls",
    description: DESCRIPTION,
    parameters: {
      path: z.string().optional().describe("Directory to list (default: current directory)"),
      limit: z.number().optional().describe("Maximum number of entries to return (default: 500)"),
    },
    implementation: async ({ path, limit }) => {
      const dirPath = path ? await resolveDirectory(ctx, path) : ctx.root;
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      let entries: string[];
      try {
        entries = [];
        for await (const entry of Deno.readDir(dirPath)) {
          entries.push(entry.name);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read directory: ${message}`);
      }

      entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

      const entryLimitReached = entries.length > effectiveLimit;
      const toProcess = entries.slice(0, effectiveLimit);
      const formatted = await Promise.all(
        toProcess.map(async (entry) => {
          const fullPath = `${dirPath}/${entry}`;
          try {
            const stat = await Deno.stat(fullPath);
            return entry + (stat.isDirectory ? "/" : "");
          } catch {
            return null;
          }
        }),
      );
      const results = formatted.filter((line): line is string => line !== null);

      if (results.length === 0) return "(empty directory)";

      const rawOutput = results.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const notices: string[] = [];
      if (entryLimitReached) {
        notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
      }
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return output;
    },
  });
}
