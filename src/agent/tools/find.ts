import { type Tool, tool } from "@lmstudio/sdk";
import * as path from "@std/path";
import { z } from "zod/v3";

import { approveToolOperation, displayPath, resolveDirectoryPath, type ToolContext } from "./context.ts";
import {
  appendSearchNotices,
  commandExists,
  readStreamToString,
  SEARCH_SKIP_DIRS,
  toPosixPath,
} from "./search-support.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 1000;

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

  async function walk(dir: string, prefix: string): Promise<void> {
    signal?.throwIfAborted();
    if (results.length >= limit) return;
    for await (const entry of Deno.readDir(dir)) {
      signal?.throwIfAborted();
      if (results.length >= limit) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      const posixRel = toPosixPath(rel);

      if (entry.isDirectory) {
        if (!SEARCH_SKIP_DIRS.has(entry.name)) await walk(fullPath, posixRel);
        continue;
      }
      if (entry.isFile) {
        const absoluteCandidate = toPosixPath(fullPath);
        if (re.test(absoluteCandidate) || re.test(posixRel)) {
          results.push(posixRel);
        }
      }
    }
  }

  await walk(searchPath, "");
  return results;
}

export function createFindTool(ctx: ToolContext): Tool {
  return tool({
    name: "find",
    description:
      `Search for files by glob pattern. Returns matching file paths relative to the search directory. Output is truncated to ${DEFAULT_LIMIT} results or ${
        DEFAULT_MAX_BYTES / 1024
      }KB (whichever is hit first).`,
    parameters: {
      pattern: z.string().describe("Glob pattern, e.g. '*.ts' or '**/*.json'"),
      path: z.string().optional().describe("Directory to search (default: workspace root)"),
      limit: z.number().optional().describe(`Maximum results (default: ${DEFAULT_LIMIT})`),
    },
    implementation: async ({ pattern, path: searchDir, limit }) => {
      const searchPath = await resolveDirectoryPath(ctx, searchDir ?? ".");
      const effectiveLimit = limit ?? DEFAULT_LIMIT;
      await approveToolOperation(ctx, {
        operation: "find",
        target: displayPath(ctx, searchPath),
        risk: "low",
        summary: `find files, limit=${effectiveLimit}`,
      });

      let relativized: string[];
      let usedFd = false;

      if (await commandExists("fd")) {
        relativized = await findWithFd(searchPath, pattern, effectiveLimit, ctx.signal);
        usedFd = true;
      } else {
        relativized = await walkFind(searchPath, pattern, effectiveLimit, ctx.signal);
      }

      if (relativized.length === 0) return "No files found matching pattern";

      const resultLimitReached = relativized.length >= effectiveLimit;
      const rawOutput = relativized.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const notices: string[] = [];
      if (!usedFd) notices.push("search: built-in walker; install fd for faster search");
      if (resultLimitReached) {
        notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more`);
      }
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      return appendSearchNotices(output, notices);
    },
  });
}
