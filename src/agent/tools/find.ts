import type { Tool } from "@lmstudio/sdk";
import { walk } from "@std/fs";
import * as path from "@std/path";
import { z } from "zod/v3";

import type { ToolContext } from "./context.ts";
import {
  type AgentToolCapabilityRequestSpec,
  type AgentToolDefinition,
  type AgentToolDeps,
  toolFromDefinition,
} from "./definitions.ts";
import {
  appendSearchNotices,
  commandExists,
  readStreamToString,
  searchSkipPatterns,
  toPosixPath,
} from "./search-support.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 1000;

const findParameters = {
  pattern: z.string().describe("Glob pattern, e.g. '*.ts' or '**/*.json'"),
  path: z.string().optional().describe(
    "Directory to search: relative (workspace), or absolute / ~/... for host directories outside the workspace",
  ),
  limit: z.number().optional().describe(`Maximum results (default: ${DEFAULT_LIMIT})`),
} as const;

function prepareGlobPattern(pattern: string): { pattern: string; fullPath: boolean } {
  if (pattern.includes("/")) {
    let effective = pattern;
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
      effective = `**/${pattern}`;
    }
    return { pattern: effective, fullPath: true };
  }
  return { pattern, fullPath: false };
}

async function findWithFd(
  searchPath: string,
  pattern: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const { pattern: effectivePattern, fullPath } = prepareGlobPattern(pattern);
  const args = ["--glob", "--color=never", "--hidden", "--type", "f", "--max-results", String(limit)];
  if (fullPath) args.push("--full-path");
  args.push("--", effectivePattern, searchPath);

  const child = new Deno.Command("fd", { args, stdout: "piped", stderr: "piped", signal }).spawn();
  const [stdout, status] = await Promise.all([
    readStreamToString(child.stdout),
    child.status,
  ]);

  if (!status.success && !stdout.trim()) {
    const err = await readStreamToString(child.stderr);
    throw new Error(err.trim() || `fd exited with code ${status.code}`);
  }

  const lines: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) continue;
    let relativePath = line;
    if (line.startsWith(searchPath)) {
      relativePath = line.slice(searchPath.length + 1);
    } else {
      relativePath = path.relative(searchPath, line);
    }
    lines.push(toPosixPath(relativePath));
  }
  return lines;
}

async function walkFind(
  searchPath: string,
  globPattern: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const { pattern: effectivePattern } = prepareGlobPattern(globPattern);
  const re = path.globToRegExp(effectivePattern, { extended: true });
  const results: string[] = [];

  for await (
    const entry of walk(searchPath, {
      includeDirs: false,
      includeFiles: true,
      skip: searchSkipPatterns(),
    })
  ) {
    signal?.throwIfAborted();
    if (results.length >= limit) break;
    if (!entry.isFile) continue;
    const posixRel = toPosixPath(path.relative(searchPath, entry.path));
    const absoluteCandidate = toPosixPath(entry.path);
    if (re.test(absoluteCandidate) || re.test(posixRel)) {
      results.push(posixRel);
    }
  }
  return results;
}

export const findToolDefinition: AgentToolDefinition<typeof findParameters> = {
  name: "find",
  description:
    `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${DEFAULT_LIMIT} results or ${
      DEFAULT_MAX_BYTES / 1024
    }KB (whichever is hit first).`,
  parameters: findParameters,
  authorize: async ({ path: searchDir, limit }, deps): Promise<AgentToolCapabilityRequestSpec> => {
    const effectiveLimit = limit ?? DEFAULT_LIMIT;
    const op = await deps.workspace.fs.operation({
      operation: "find",
      path: searchDir ?? ".",
      access: "read",
      require: "existingDirectory",
      externalCommands: ["fd"],
      summary: `find files, limit=${effectiveLimit}`,
    });
    return op.capabilityRequest();
  },
  run: async ({ pattern, path: searchDir, limit }, deps): Promise<string> => {
    const ctx = deps.workspace;
    const effectiveLimit = limit ?? DEFAULT_LIMIT;
    const op = await ctx.fs.operation({
      operation: "find",
      path: searchDir ?? ".",
      access: "read",
      require: "existingDirectory",
      externalCommands: ["fd"],
      summary: `find files, limit=${effectiveLimit}`,
    });

    return await op.withAccess(async ({ absolutePath, signal }) => {
      const searchPath = absolutePath;

      let relativized: string[];
      let usedFd = false;

      if (await commandExists("fd", signal)) {
        relativized = await findWithFd(searchPath, pattern, effectiveLimit, signal);
        usedFd = true;
      } else {
        relativized = await walkFind(searchPath, pattern, effectiveLimit, signal);
      }

      if (relativized.length === 0) return "No files found matching pattern";

      const resultLimitReached = relativized.length >= effectiveLimit;
      const rawOutput = relativized.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      const output = truncation.content;
      const notices: string[] = [];
      if (!usedFd) notices.push("search: built-in walker; install fd for faster search");
      if (resultLimitReached) {
        notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more`);
      }
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      return appendSearchNotices(output, notices);
    });
  },
};

export function createFindTool(ctx: ToolContext): Tool {
  return toolFromDefinition(findToolDefinition, { workspace: ctx } as AgentToolDeps);
}
