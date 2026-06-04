import type { Tool } from "@lmstudio/sdk";
import * as path from "@std/path";
import { z } from "zod/v3";

import type { ApprovalRequest } from "../../shared/approval.ts";
import type { ToolContext } from "./context.ts";
import { type AgentToolDefinition, type AgentToolDeps, toolFromDefinition } from "./definitions.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 500;

const lsParameters = {
  path: z.string().optional().describe(
    "Directory to list: relative (workspace), or absolute / ~/... for host directories outside the workspace",
  ),
  limit: z.number().optional().describe(`Maximum number of entries to return (default: ${DEFAULT_LIMIT})`),
} as const;

export const lsToolDefinition: AgentToolDefinition<typeof lsParameters> = {
  name: "ls",
  description:
    `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${
      DEFAULT_MAX_BYTES / 1024
    }KB (whichever is hit first).`,
  parameters: lsParameters,
  authorize: async ({ path: userPath, limit }, deps): Promise<ApprovalRequest> => {
    const effectiveLimit = limit ?? DEFAULT_LIMIT;
    const op = await deps.workspace.fs.operation({
      operation: "list",
      path: userPath ?? ".",
      access: "read",
      require: "existingDirectory",
      summary: `list directory, limit=${effectiveLimit}`,
    });
    return op.approvalRequest();
  },
  run: async ({ path: userPath, limit }, deps): Promise<string> => {
    const ctx = deps.workspace;
    const effectiveLimit = limit ?? DEFAULT_LIMIT;
    const op = await ctx.fs.operation({
      operation: "list",
      path: userPath ?? ".",
      access: "read",
      require: "existingDirectory",
      summary: `list directory, limit=${effectiveLimit}`,
    });

    return await op.withAccess(async ({ absolutePath }) => {
      const dirPath = absolutePath;

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

      const sortedEntries = entries.toSorted((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const limitedEntries = sortedEntries.slice(0, effectiveLimit);

      if (limitedEntries.length === 0) return "(empty directory)";

      const entryLimitReached = sortedEntries.length > effectiveLimit;
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
    });
  },
};

export function createLsTool(ctx: ToolContext): Tool {
  return toolFromDefinition(lsToolDefinition, { workspace: ctx } as AgentToolDeps);
}
