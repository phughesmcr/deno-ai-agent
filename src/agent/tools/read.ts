import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { grantBrokerReadPath, shouldRunPermissionControlClient } from "../../permission-broker/mod.ts";
import { DEFAULT_APPROVAL_TIMEOUT_MS } from "../../shared/approval.ts";
import { approveToolOperation, displayPath, resolveReadPath, type ToolContext } from "./context.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function isImagePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export function createReadTool(ctx: ToolContext): Tool {
  return tool({
    name: "read",
    description: `Read the contents of a file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${
      DEFAULT_MAX_BYTES / 1024
    }KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete. Images are not supported in phase 1. Use a relative path for workspace files. For host files outside the workspace, use this tool with an absolute path or \`~/...\` (requires Telegram approval)—do not use bash for host file reads.`,
    parameters: {
      path: z.string().describe(
        "Path to read: relative (workspace), or absolute / ~/... for host files outside the workspace",
      ),
      offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
      limit: z.number().optional().describe("Maximum number of lines to read"),
    },
    implementation: async ({ path: userPath, offset, limit }) => {
      const { absolutePath, outsideWorkspace } = await resolveReadPath(ctx, userPath);
      if (isImagePath(absolutePath)) {
        throw new Error(`Cannot read image file as text: ${displayPath(ctx, absolutePath)}`);
      }
      const display = displayPath(ctx, absolutePath);
      const rangeSummary = offset || limit ?
        `read text with offset=${offset ?? 1}, limit=${limit ?? "default"}` :
        "read text";
      if (outsideWorkspace) {
        console.log(`read (host): ${absolutePath} — waiting for Telegram approval`);
      }
      await approveToolOperation(ctx, {
        operation: "read",
        target: outsideWorkspace ? absolutePath : display,
        risk: outsideWorkspace ? "high" : "low",
        summary: outsideWorkspace ? `host ${rangeSummary}` : rangeSummary,
        timeoutMs: outsideWorkspace ? DEFAULT_APPROVAL_TIMEOUT_MS * 2 : undefined,
      });
      if (outsideWorkspace && shouldRunPermissionControlClient()) {
        await grantBrokerReadPath(absolutePath);
      }

      let text: string;
      try {
        text = await Deno.readTextFile(absolutePath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new Error(`Path not found: ${display}`);
        }
        throw error;
      }

      const allLines = text.split("\n");
      const totalFileLines = allLines.length;
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      const startLineDisplay = startLine + 1;

      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }

      let selectedContent: string;
      let userLimitedLines: number | undefined;

      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selectedContent = allLines.slice(startLine, endLine).join("\n");
        userLimitedLines = endLine - startLine;
      } else {
        selectedContent = allLines.slice(startLine).join("\n");
      }

      const truncation = truncateHead(selectedContent);
      let outputText: string;

      if (truncation.firstLineExceedsLimit) {
        const firstLine = allLines[startLine] ?? "";
        const firstLineSize = formatSize(new TextEncoder().encode(firstLine).length);
        outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${
          formatSize(DEFAULT_MAX_BYTES)
        } limit. Use bash: sed -n '${startLineDisplay}p' '${userPath}' | head -c ${DEFAULT_MAX_BYTES}]`;
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === "lines") {
          outputText +=
            `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${
            formatSize(DEFAULT_MAX_BYTES)
          } limit). Use offset=${nextOffset} to continue.]`;
        }
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText =
          `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }

      return outputText;
    },
  });
}
