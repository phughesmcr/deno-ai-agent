import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { relativeToRoot, resolvePath, type ToolContext } from "./context.ts";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.ts";

const DEFAULT_LIMIT = 100;

const DESCRIPTION =
  `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore when ripgrep is available. Output is truncated to ${DEFAULT_LIMIT} matches or ${
    DEFAULT_MAX_BYTES / 1024
  }KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`;

const SKIP_DIRS = new Set([".git", "node_modules"]);

export interface GrepOptions {
  forceFallback?: boolean;
}

async function rgAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("rg", { args: ["--version"], stdout: "null", stderr: "null" });
    const status = await cmd.output();
    return status.success;
  } catch {
    return false;
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const fullPath = `${current}/${entry.name}`;
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile) {
        files.push(fullPath);
      }
    }
  }
  await walk(dir);
  return files;
}

function matchesGlob(filePath: string, glob: string): boolean {
  const name = filePath.split("/").pop() ?? filePath;
  const regex = globToSimpleRegex(glob);
  return regex.test(name) || regex.test(filePath);
}

function globToSimpleRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

async function grepFallback(
  ctx: ToolContext,
  searchPath: string,
  pattern: string,
  options: {
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit: number;
  },
): Promise<string> {
  const regex = options.literal ? null : new RegExp(pattern, options.ignoreCase ? "i" : undefined);
  const contextLines = options.context && options.context > 0 ? options.context : 0;
  const files = await walkFiles(searchPath);
  const outputLines: string[] = [];
  let matchCount = 0;
  let linesTruncated = false;

  for (const filePath of files) {
    if (matchCount >= options.limit) break;
    if (options.glob && !matchesGlob(filePath, options.glob)) continue;

    let content: string;
    try {
      // deno-lint-ignore no-await-in-loop -- sequential scan; early exit on match limit
      content = await Deno.readTextFile(filePath);
    } catch {
      continue;
    }

    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matchCount >= options.limit) break;
      const line = lines[i] ?? "";
      const matched = options.literal ?
        (options.ignoreCase ? line.toLowerCase().includes(pattern.toLowerCase()) : line.includes(pattern)) :
        regex!.test(line);

      if (!matched) continue;
      matchCount++;

      const relativePath = relativeToRoot(ctx, filePath);
      const start = contextLines > 0 ? Math.max(0, i - contextLines) : i;
      const end = contextLines > 0 ? Math.min(lines.length - 1, i + contextLines) : i;

      for (let current = start; current <= end; current++) {
        const lineText = lines[current] ?? "";
        const { text: truncatedText, wasTruncated } = truncateLine(lineText.replace(/\r/g, ""));
        if (wasTruncated) linesTruncated = true;
        if (current === i) {
          outputLines.push(`${relativePath}:${current + 1}: ${truncatedText}`);
        } else {
          outputLines.push(`${relativePath}-${current + 1}- ${truncatedText}`);
        }
      }
    }
  }

  if (matchCount === 0) return "No matches found";

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const notices: string[] = [];
  if (matchCount >= options.limit) {
    notices.push(`${options.limit} matches limit reached. Use limit=${options.limit * 2} for more, or refine pattern`);
  }
  if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return output;
}

async function grepRipgrep(
  ctx: ToolContext,
  searchPath: string,
  pattern: string,
  isDirectory: boolean,
  options: {
    glob?: string;
    ignoreCase?: boolean;
    literal?: boolean;
    context?: number;
    limit: number;
  },
): Promise<string> {
  const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
  if (options.ignoreCase) args.push("--ignore-case");
  if (options.literal) args.push("--fixed-strings");
  if (options.glob) args.push("--glob", options.glob);
  args.push("--", pattern, searchPath);

  const cmd = new Deno.Command("rg", { args, stdout: "piped", stderr: "piped" });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  if (!output.success && output.code !== 1) {
    throw new Error(stderr.trim() || `ripgrep exited with code ${output.code}`);
  }

  const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim() || matches.length >= options.limit) continue;
    let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "match") {
      const filePath = event.data?.path?.text;
      const lineNumber = event.data?.line_number;
      if (filePath && typeof lineNumber === "number") {
        matches.push({ filePath, lineNumber, lineText: event.data?.lines?.text });
      }
    }
  }

  if (matches.length === 0) return "No matches found";

  const contextValue = options.context && options.context > 0 ? options.context : 0;
  const fileCache = new Map<string, string[]>();
  const outputLines: string[] = [];
  let linesTruncated = false;

  for (const match of matches) {
    let displayPath = match.filePath;
    if (isDirectory) {
      displayPath = relativeToRoot(ctx, match.filePath);
    }

    if (contextValue === 0 && match.lineText !== undefined) {
      const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(`${displayPath}:${match.lineNumber}: ${truncatedText}`);
    } else {
      let fileLines = fileCache.get(match.filePath);
      if (!fileLines) {
        try {
          // deno-lint-ignore no-await-in-loop -- one read per file, cached for context lines
          const content = await Deno.readTextFile(match.filePath);
          fileLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        } catch {
          fileLines = [];
        }
        fileCache.set(match.filePath, fileLines);
      }
      const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
      const end = contextValue > 0 ? Math.min(fileLines.length, match.lineNumber + contextValue) : match.lineNumber;
      for (let current = start; current <= end; current++) {
        const lineText = fileLines[current - 1] ?? "";
        const { text: truncatedText, wasTruncated } = truncateLine(lineText.replace(/\r/g, ""));
        if (wasTruncated) linesTruncated = true;
        if (current === match.lineNumber) {
          outputLines.push(`${displayPath}:${current}: ${truncatedText}`);
        } else {
          outputLines.push(`${displayPath}-${current}- ${truncatedText}`);
        }
      }
    }
  }

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let result = truncation.content;
  const notices: string[] = [];
  if (matches.length >= options.limit) {
    notices.push(`${options.limit} matches limit reached. Use limit=${options.limit * 2} for more, or refine pattern`);
  }
  if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
  }
  if (notices.length > 0) result += `\n\n[${notices.join(". ")}]`;
  return result;
}

export function createGrepTool(ctx: ToolContext, options?: GrepOptions): ReturnType<typeof tool> {
  return tool({
    name: "grep",
    description: DESCRIPTION,
    parameters: {
      pattern: z.string().describe("Search pattern (regex or literal string)"),
      path: z.string().optional().describe("Directory or file to search (default: current directory)"),
      glob: z.string().optional().describe("Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"),
      ignoreCase: z.boolean().optional().describe("Case-insensitive search (default: false)"),
      literal: z.boolean().optional().describe("Treat pattern as literal string instead of regex (default: false)"),
      context: z.number().optional().describe("Number of lines to show before and after each match (default: 0)"),
      limit: z.number().optional().describe("Maximum number of matches to return (default: 100)"),
    },
    implementation: async ({ pattern, path: searchDir, glob, ignoreCase, literal, context, limit }) => {
      const searchPath = searchDir ? await resolvePath(ctx, searchDir) : ctx.root;
      let isDirectory: boolean;
      try {
        const stat = await Deno.stat(searchPath);
        isDirectory = stat.isDirectory;
      } catch {
        throw new Error(`Path not found: ${searchDir ?? "."}`);
      }

      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
      const grepOptions = { glob, ignoreCase, literal, context, limit: effectiveLimit };

      const useFallback = options?.forceFallback === true || !(await rgAvailable());
      if (useFallback) {
        const notice = options?.forceFallback !== true ? "[ripgrep not found; using built-in search]\n\n" : "";
        return notice + await grepFallback(ctx, searchPath, pattern, grepOptions);
      }

      if (!isDirectory) {
        return await grepRipgrep(ctx, searchPath, pattern, false, grepOptions);
      }
      return await grepRipgrep(ctx, searchPath, pattern, true, grepOptions);
    },
  });
}
