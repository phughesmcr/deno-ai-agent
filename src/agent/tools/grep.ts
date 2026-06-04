import type { Tool } from "@lmstudio/sdk";
import { walk } from "@std/fs";
import * as path from "@std/path";
import { z } from "zod/v3";

import type { ApprovalRequest } from "../../shared/approval.ts";
import type { ToolContext } from "./context.ts";
import { type AgentToolDefinition, type AgentToolDeps, toolFromDefinition } from "./definitions.ts";
import {
  appendSearchNotices,
  commandExists,
  readStreamToString,
  searchSkipPatterns,
  toPosixPath,
} from "./search-support.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from "./truncate.ts";

const DEFAULT_LIMIT = 100;

const grepParameters = {
  pattern: z.string().describe("Search pattern (regex or literal string)"),
  path: z.string().optional().describe(
    "Directory or file to search: relative (workspace), or absolute / ~/... for host paths outside the workspace",
  ),
  glob: z.string().optional().describe("Filter files by glob pattern"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive search"),
  literal: z.boolean().optional().describe("Treat pattern as literal string"),
  context: z.number().optional().describe("Lines of context before and after each match"),
  limit: z.number().optional().describe(`Maximum matches (default: ${DEFAULT_LIMIT})`),
} as const;

async function grepWithRg(
  searchPath: string,
  pattern: string,
  options: {
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit: number;
    targetIsFile: boolean;
    signal?: AbortSignal;
  },
): Promise<{ output: string; usedRg: boolean; linesTruncated: boolean; matchLimitReached: boolean }> {
  const args = ["--json", "--line-number", "--color=never", "--hidden"];
  if (options.ignoreCase) args.push("--ignore-case");
  if (options.literal) args.push("--fixed-strings");
  const contextValue = options.context && options.context > 0 ? options.context : 0;
  if (contextValue > 0) args.push("--context", String(contextValue));
  if (options.glob) args.push("--glob", options.glob);
  args.push("--", pattern, searchPath);

  const child = new Deno.Command("rg", { args, stdout: "piped", stderr: "piped", signal: options.signal }).spawn();
  const [stdout, status] = await Promise.all([
    readStreamToString(child.stdout),
    child.status,
  ]);

  if (!status.success && status.code !== 1) {
    const err = await readStreamToString(child.stderr);
    throw new Error(err.trim() || `ripgrep exited with code ${status.code}`);
  }

  const outputLines: string[] = [];
  let matchCount = 0;
  let linesTruncated = false;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "match" && event.type !== "context") continue;
    if (event.type === "match") {
      if (matchCount >= options.limit) continue;
      matchCount++;
    } else if (matchCount >= options.limit) {
      continue;
    }

    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const lineText = event.data?.lines?.text;
    if (!filePath || typeof lineNumber !== "number") continue;

    const relativePath = options.targetIsFile ?
      path.basename(filePath) :
      toPosixPath(path.relative(searchPath, filePath)) || path.basename(filePath);
    const sanitized = (lineText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
    const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
    if (wasTruncated) linesTruncated = true;
    const separator = event.type === "match" ? ":" : "-";
    outputLines.push(`${relativePath}:${lineNumber}${separator} ${truncatedText}`);
  }

  return {
    output: outputLines.join("\n"),
    usedRg: true,
    linesTruncated,
    matchLimitReached: matchCount >= options.limit,
  };
}

async function walkGrep(
  searchPath: string,
  pattern: RegExp,
  options: { glob?: string; limit: number; context?: number; targetIsFile: boolean; signal?: AbortSignal },
): Promise<{ output: string; linesTruncated: boolean; matchLimitReached: boolean }> {
  const globRe = options.glob ? path.globToRegExp(options.glob) : null;
  const outputLines: string[] = [];
  let linesTruncated = false;
  let matchCount = 0;
  const contextValue = options.context && options.context > 0 ? options.context : 0;

  async function grepFile(fullPath: string, rel: string): Promise<void> {
    options.signal?.throwIfAborted();
    let content: string;
    try {
      content = await Deno.readTextFile(fullPath);
    } catch {
      return;
    }
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matchCount >= options.limit) return;
      const line = lines[i] ?? "";
      if (!pattern.test(line)) continue;
      matchCount++;

      const start = Math.max(0, i - contextValue);
      const end = Math.min(lines.length - 1, i + contextValue);
      for (let j = start; j <= end; j++) {
        const contextLine = lines[j] ?? "";
        const { text: truncatedText, wasTruncated } = truncateLine(contextLine);
        if (wasTruncated) linesTruncated = true;
        const separator = j === i ? ":" : "-";
        outputLines.push(`${rel}:${j + 1}${separator} ${truncatedText}`);
      }
    }
  }

  if (options.targetIsFile) {
    await grepFile(searchPath, path.basename(searchPath));
  } else {
    for await (
      const entry of walk(searchPath, {
        includeDirs: false,
        includeFiles: true,
        skip: searchSkipPatterns(),
      })
    ) {
      options.signal?.throwIfAborted();
      if (matchCount >= options.limit) break;
      if (!entry.isFile) continue;
      const rel = toPosixPath(path.relative(searchPath, entry.path));
      if (globRe && !globRe.test(rel) && !globRe.test(entry.name)) continue;
      await grepFile(entry.path, rel);
    }
  }
  return { output: outputLines.join("\n"), linesTruncated, matchLimitReached: matchCount >= options.limit };
}

export const grepToolDefinition: AgentToolDefinition<typeof grepParameters> = {
  name: "grep",
  description:
    `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${DEFAULT_LIMIT} matches or ${
      DEFAULT_MAX_BYTES / 1024
    }KB (whichever is hit first).`,
  parameters: grepParameters,
  authorize: async ({ path: searchDir, limit, context }, deps): Promise<ApprovalRequest> => {
    const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
    const effectiveContext = context ?? 0;
    const op = await deps.workspace.fs.operation({
      operation: "grep",
      path: searchDir ?? ".",
      access: "read",
      require: "existingFileOrDirectory",
      externalCommands: ["rg"],
      summary: `search text, limit=${effectiveLimit}, context=${effectiveContext}`,
    });
    return op.approvalRequest();
  },
  run: async ({ pattern, path: searchDir, glob, ignoreCase, literal, context, limit }, deps): Promise<string> => {
    const ctx = deps.workspace;
    const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
    const effectiveContext = context ?? 0;
    const op = await ctx.fs.operation({
      operation: "grep",
      path: searchDir ?? ".",
      access: "read",
      require: "existingFileOrDirectory",
      externalCommands: ["rg"],
      summary: `search text, limit=${effectiveLimit}, context=${effectiveContext}`,
    });

    return await op.withAccess(async ({ absolutePath, kind, signal }) => {
      const searchPath = absolutePath;
      const targetIsFile = kind === "file";

      let output: string;
      let usedRg = false;
      let linesTruncated = false;
      let matchLimitReached = false;

      if (await commandExists("rg", signal)) {
        const result = await grepWithRg(searchPath, pattern, {
          glob,
          ignoreCase,
          literal,
          context,
          limit: effectiveLimit,
          targetIsFile,
          signal,
        });
        output = result.output;
        usedRg = true;
        linesTruncated = result.linesTruncated;
        matchLimitReached = result.matchLimitReached;
      } else {
        const flags = ignoreCase ? "i" : "";
        const regex = literal ?
          new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags) :
          new RegExp(pattern, flags);
        const result = await walkGrep(searchPath, regex, {
          glob,
          limit: effectiveLimit,
          context,
          targetIsFile,
          signal,
        });
        output = result.output;
        linesTruncated = result.linesTruncated;
        matchLimitReached = result.matchLimitReached;
      }

      if (!output) return "No matches found";

      const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER });
      const resultOutput = truncation.content;
      const notices: string[] = [];
      if (!usedRg) notices.push("search: built-in walker; install ripgrep for faster search");
      if (matchLimitReached) {
        notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more`);
      }
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      if (linesTruncated) notices.push("some lines truncated");
      return appendSearchNotices(resultOutput, notices);
    });
  },
};

export function createGrepTool(ctx: ToolContext): Tool {
  return toolFromDefinition(grepToolDefinition, { workspace: ctx } as AgentToolDeps);
}
