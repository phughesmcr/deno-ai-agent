import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { resolvePath, type ToolContext } from "./context.ts";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./mutation-queue.ts";

const DESCRIPTION =
  "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.";

const editSchema = z.object({
  oldText: z.string().describe(
    "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
  ),
  newText: z.string().describe("Replacement text for this targeted edit."),
});

interface EditInput {
  path: string;
  edits?: Edit[];
  oldText?: string;
  newText?: string;
}

function prepareEditArguments(input: EditInput): { path: string; edits: Edit[] } {
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    const edits = Array.isArray(input.edits) ? [...input.edits] : [];
    edits.push({ oldText: input.oldText, newText: input.newText });
    return { path: input.path, edits };
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits };
}

export function createEditTool(ctx: ToolContext): ReturnType<typeof tool> {
  return tool({
    name: "edit",
    description: DESCRIPTION,
    parameters: {
      path: z.string().describe("Path to the file to edit (relative or absolute)"),
      edits: z.array(editSchema).describe(
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      ),
      oldText: z.string().optional().describe("Legacy single-edit oldText (merged into edits[])"),
      newText: z.string().optional().describe("Legacy single-edit newText (merged into edits[])"),
    },
    implementation: async (input: EditInput) => {
      const { path, edits } = prepareEditArguments(input);
      const absolutePath = await resolvePath(ctx, path);

      return await withFileMutationQueue(absolutePath, async () => {
        let rawContent: string;
        try {
          rawContent = await Deno.readTextFile(absolutePath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Could not edit file: ${path}. ${message}.`);
        }

        const { bom, text: content } = stripBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        const { newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
        const finalContent = bom + restoreLineEndings(newContent, originalEnding);
        await Deno.writeTextFile(absolutePath, finalContent);
        return `Successfully replaced ${edits.length} block(s) in ${path}.`;
      });
    },
  });
}
