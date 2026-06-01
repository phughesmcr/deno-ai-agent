import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { approveToolOperation, displayPath, resolvePath, type ToolContext } from "./context.ts";
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

export function createEditTool(ctx: ToolContext): unknown {
  return tool({
    name: "edit",
    description:
      "Edit a file using exact text replacement. Each edits[].oldText must match a unique, non-overlapping region of the original file. Edits are matched against the original file, not incrementally.",
    parameters: {
      path: z.string().describe("Path to the file to edit (relative or absolute, under workspace)"),
      edits: z.array(editEntrySchema).describe("One or more targeted replacements"),
    },
    implementation: async (raw: EditInput) => {
      const { path: userPath, edits } = prepareEditInput(raw);
      const absolutePath = await resolvePath(ctx, userPath);
      const display = displayPath(ctx, absolutePath);
      await approveToolOperation(ctx, {
        operation: "edit",
        target: display,
        risk: "medium",
        summary: `replace ${edits.length} block(s)`,
      });

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
