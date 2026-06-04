import type { Tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import type { ApprovalRequest } from "../../shared/approval.ts";
import { requestForHostAwareOperation } from "./approval-support.ts";
import { displayPath, grantBrokerHostReadWrite, resolveHostAwarePath, type ToolContext } from "./context.ts";
import { type AgentToolDefinition, type AgentToolDeps, toolFromDefinition } from "./definitions.ts";
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

const editParameters = {
  path: z.string().describe(
    "Path to edit: relative (workspace), or absolute / ~/... for host files outside the workspace",
  ),
  edits: z.array(editEntrySchema).min(1).describe("One or more targeted replacements"),
} as const;

function assertEdits(edits: Edit[]): void {
  if (edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
}

export const editToolDefinition: AgentToolDefinition<typeof editParameters> = {
  name: "edit",
  description:
    "Edit a file using exact text replacement. Each edits[].oldText must match a unique, non-overlapping region of the original file. Edits are matched against the original file, not incrementally.",
  parameters: editParameters,
  authorize: async ({ path: userPath, edits }, deps): Promise<ApprovalRequest> => {
    assertEdits(edits);
    const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(deps.workspace, userPath);
    return requestForHostAwareOperation(deps.workspace, {
      operation: "edit",
      absolutePath,
      outsideWorkspace,
      display: displayPath(deps.workspace, absolutePath),
      workspaceRisk: "medium",
      summary: `replace ${edits.length} block(s)`,
    });
  },
  run: async ({ path: userPath, edits }, deps): Promise<string> => {
    const ctx = deps.workspace;
    assertEdits(edits);
    const { absolutePath, outsideWorkspace } = await resolveHostAwarePath(ctx, userPath);
    const display = displayPath(ctx, absolutePath);
    if (outsideWorkspace) await grantBrokerHostReadWrite(absolutePath, ctx.signal);

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
};

export function createEditTool(ctx: ToolContext): Tool {
  return toolFromDefinition(editToolDefinition, { workspace: ctx } as AgentToolDeps);
}
