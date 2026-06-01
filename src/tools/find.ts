import { tool } from "@lmstudio/sdk";
import { globToRegExp } from "@std/path/glob-to-regexp";
import { z } from "zod/v3";

import { relativeToRoot, resolveDirectory, type ToolContext } from "./context.ts";
import { toPosixPath } from "./path.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 1000;

const DESCRIPTION =
  `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore when fd is available. Output is truncated to ${DEFAULT_LIMIT} results or ${
    DEFAULT_MAX_BYTES / 1024
  }KB (whichever is hit first).`;

const SKIP_DIRS = new Set([".git", "node_modules"]);

export interface FindOptions {
  forceFallback?: boolean;
}

async function fdAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("fd", { args: ["--version"], stdout: "null", stderr: "null" });
    const status = await cmd.output();
    return status.success;
  } catch {
    return false;
  }
}

async function walkAll(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const fullPath = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile) {
        results.push(fullPath);
      }
    }
  }
  await walk(dir);
  return results;
}

function matchGlobPattern(relativePath: string, pattern: string): boolean {
  let effectivePattern = pattern;
  if (pattern.includes("/") && !pattern.startsWith("**/") && !pattern.startsWith("/")) {
    effectivePattern = `**/${pattern}`;
  }
  const regex = globToRegExp(effectivePattern, { extended: true, globstar: true, caseInsensitive: false });
  return regex.test(relativePath) || regex.test(relativePath.split("/").pop() ?? relativePath);
}

async function findFallback(
  ctx: ToolContext,
  searchPath: string,
  pattern: string,
  limit: number,
): Promise<string> {
  const allFiles = await walkAll(searchPath);
  const matched: string[] = [];

  for (const filePath of allFiles) {
    if (matched.length >= limit) break;
    const relativePath = relativeToRoot(ctx, filePath);
    if (matchGlobPattern(relativePath, pattern)) {
      matched.push(toPosixPath(relativePath));
    }
  }

  if (matched.length === 0) return "No files found matching pattern";
  return formatFindOutput(matched, limit);
}

async function findFd(
  ctx: ToolContext,
  searchPath: string,
  pattern: string,
  limit: number,
): Promise<string> {
  let effectivePattern = pattern;
  const args: string[] = [
    "--glob",
    "--color=never",
    "--hidden",
    "--max-results",
    String(limit),
  ];

  if (pattern.includes("/")) {
    args.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
      effectivePattern = `**/${pattern}`;
    }
  }
  args.push("--", effectivePattern, searchPath);

  const cmd = new Deno.Command("fd", { args, stdout: "piped", stderr: "piped" });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  if (!output.success && !stdout.trim()) {
    throw new Error(stderr.trim() || `fd exited with code ${output.code}`);
  }

  const relativized: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) continue;
    const hadTrailingSlash = line.endsWith("/");
    let relativePath = line;
    if (line.startsWith(searchPath)) {
      relativePath = line.slice(searchPath.length + 1);
    } else {
      relativePath = relativeToRoot(ctx, line);
    }
    if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
    relativized.push(toPosixPath(relativePath));
  }

  if (relativized.length === 0) return "No files found matching pattern";
  return formatFindOutput(relativized, limit);
}

function formatFindOutput(paths: string[], limit: number): string {
  const resultLimitReached = paths.length >= limit;
  const rawOutput = paths.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const notices: string[] = [];
  if (resultLimitReached) {
    notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
  }
  if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return output;
}

export function createFindTool(ctx: ToolContext, options?: FindOptions): ReturnType<typeof tool> {
  return tool({
    name: "find",
    description: DESCRIPTION,
    parameters: {
      pattern: z.string().describe("Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"),
      path: z.string().optional().describe("Directory to search in (default: current directory)"),
      limit: z.number().optional().describe("Maximum number of results (default: 1000)"),
    },
    implementation: async ({ pattern, path: searchDir, limit }) => {
      const searchPath = searchDir ? await resolveDirectory(ctx, searchDir) : ctx.root;
      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      const useFallback = options?.forceFallback === true || !(await fdAvailable());
      if (useFallback) {
        const notice = options?.forceFallback !== true ? "[fd not found; using built-in search]\n\n" : "";
        return notice + await findFallback(ctx, searchPath, pattern, effectiveLimit);
      }
      return await findFd(ctx, searchPath, pattern, effectiveLimit);
    },
  });
}
