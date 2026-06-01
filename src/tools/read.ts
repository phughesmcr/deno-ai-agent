import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { resolvePath, type ToolContext } from "./context.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

const DESCRIPTION =
  `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${
    DEFAULT_MAX_BYTES / 1024
  }KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`;

export function createReadTool(ctx: ToolContext): ReturnType<typeof tool> {
  return tool({
    name: "read",
    description: DESCRIPTION,
    parameters: {
      path: z.string().describe("Path to the file to read (relative or absolute)"),
      offset: z.number().optional().describe("Line number to start reading from (1-indexed)"),
      limit: z.number().optional().describe("Maximum number of lines to read"),
    },
    implementation: async ({ path, offset, limit }) => {
      const absolutePath = await resolvePath(ctx, path);
      if (isImagePath(absolutePath)) {
        return `Image file at ${path}. Text-only read tool cannot display binary image content.`;
      }

      let textContent: string;
      try {
        textContent = await Deno.readTextFile(absolutePath);
      } catch {
        throw new Error(`Path not found: ${path}`);
      }

      const allLines = textContent.split("\n");
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

      if (truncation.firstLineExceedsLimit) {
        const firstLine = allLines[startLine] ?? "";
        const firstLineSize = formatSize(new TextEncoder().encode(firstLine).length);
        return `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${
          formatSize(DEFAULT_MAX_BYTES)
        } limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
      }

      if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        let outputText = truncation.content;
        if (truncation.truncatedBy === "lines") {
          outputText +=
            `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${
            formatSize(DEFAULT_MAX_BYTES)
          } limit). Use offset=${nextOffset} to continue.]`;
        }
        return outputText;
      }

      if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      }

      return truncation.content;
    },
  });
}
