import { createBashTool } from "./bash.ts";
import type { ToolContext } from "./context.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { normalizeRoot } from "./path.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

/** Names of workspace-scoped tools registered with the model. */
export type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

export type { ToolContext } from "./context.ts";
export { prepareSystemPrompt, ToolNames } from "./prompt.ts";

/** Returns the LM Studio tools available to the model, scoped to the workspace root. */
export function getModelTools(ctx: ToolContext): unknown[] {
  const root = normalizeRoot(ctx.root);
  const context: ToolContext = { root };
  return [
    createReadTool(context),
    createWriteTool(context),
    createEditTool(context),
    createBashTool(context),
    createGrepTool(context),
    createFindTool(context),
    createLsTool(context),
  ];
}
