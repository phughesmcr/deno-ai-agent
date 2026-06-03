import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import {
  approveHostAwareToolOperation,
  displayPath,
  grantBrokerHostReadWrite,
  resolveHostAwarePath,
  type ToolContext,
} from "./context.ts";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";

const editEntrySchema = z.object({
  oldText: z.string().describe("Exact text to replace (unique in file, non-overlapping with other edits)"),
  newText: z.string().describe("Replacement text"),
});

type EditInput = {
  path: string;
  edits?: Edit[];
  oldText?: string;
  newText?: string;
};

function prepareEditInput(input: EditInput): { path: string; edits: Edit[] } {
  const edits = Array.isArray(input.edits) ? [...input.edits] : [];
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    edits.push({ oldText: input.oldText, newText: input.newText });
  }
  if (edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits };
}

export function createEditTool(ctx: ToolContext): Tool {
  return tool({
    name: "edit",
    description:
      "Edit a file using exact text replacement. Each edits[].oldText must match a unique, non-overlapping region of the original file. Edits are matched against the original file, not incrementally.",
    parameters: {
      path: z.string().describe(
        "Path to edit: relative (workspace), or absolute / ~/... for host files outside the workspace",
      ),
      edits: z.array(editEntrySchema).describe("One or more targeted replacements"),
    },
    implementation: async (raw: EditInput) => {
      const { path: userPath, edits } = prepareEditInput(raw);
      const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
      const display = displayPath(ctx, absolutePath);
      await approveHostAwareToolOperation(ctx, {
        operation: "edit",
        absolutePath,
        outsideWorkspace,
        display,
        workspaceRisk: "medium",
        summary: `replace ${edits.length} block(s)`,
      });
      if (outsideWorkspace) await grantBrokerHostReadWrite(absolutePath);

      return await withFileMutationQueue(absolutePath, async () => {
        let rawContent: string;
        try {
          rawContent = await Deno.readTextFile(absolutePath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            throw new Error(`Could not edit file: ${display}. Path not found.`);
          }
          throw error;
        }

        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        const { newContent } = applyEditsToNormalizedContent(normalizedContent, edits, display);
        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        await Deno.writeTextFile(absolutePath, finalContent);
        return `Successfully replaced ${edits.length} block(s) in ${display}.`;
      });
    },
  });
}
