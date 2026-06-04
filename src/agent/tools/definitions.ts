import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import type { ApprovalGate, ApprovalRequest } from "../../shared/approval.ts";
import type { SkillManager } from "../skills/mod.ts";
import type { SubagentPort } from "../subagents.ts";
import type { ToolContext } from "./context.ts";
import type { TodoWriteDeps } from "./todo-write.ts";
import { withRecoverableToolErrors } from "./tool-errors.ts";
import type { AskUserQuestionPort } from "./user-question-port.ts";

/** Pi-aligned tool identifiers registered with the model. */
export type ToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "typescript-repl"
  | "grep"
  | "find"
  | "ls"
  | "skill"
  | "todo_write"
  | "web-fetch"
  | "ask_user_question"
  | "subagent";

/** All local tool names in registration order. */
export const allToolNames: ToolName[] = [
  "read",
  "write",
  "edit",
  "bash",
  "typescript-repl",
  "grep",
  "find",
  "ls",
  "skill",
  "todo_write",
  "web-fetch",
  "ask_user_question",
  "subagent",
];

export type ToolParams<TShape extends z.ZodRawShape> = z.infer<z.ZodObject<TShape>>;

export interface AgentToolDeps {
  workspace: ToolContext;
  approvalGate: ApprovalGate;
  userQuestions: AskUserQuestionPort;
  todos: TodoWriteDeps;
  skills: {
    manager: SkillManager;
    getSessionId: () => string;
  };
  subagents: SubagentPort;
  mcp?: { getTools(): Tool[] };
}

export interface AgentToolDefinition<TShape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: ToolName;
  readonly description: string | ((deps: AgentToolDeps) => string);
  readonly parameters: TShape;
  authorize(
    params: ToolParams<TShape>,
    deps: AgentToolDeps,
  ): ApprovalRequest | null | Promise<ApprovalRequest | null>;
  run(
    params: ToolParams<TShape>,
    deps: AgentToolDeps,
  ): string | Promise<string>;
}

export function parseToolParams<TShape extends z.ZodRawShape>(
  definition: AgentToolDefinition<TShape>,
  raw: Record<string, unknown> | undefined,
): ToolParams<TShape> {
  return z.object(definition.parameters).parse(raw ?? {});
}

export function toolFromDefinition<TShape extends z.ZodRawShape>(
  definition: AgentToolDefinition<TShape>,
  deps: AgentToolDeps,
): Tool {
  const description = typeof definition.description === "function" ?
    definition.description(deps) :
    definition.description;
  return withRecoverableToolErrors(
    tool({
      name: definition.name,
      description,
      parameters: definition.parameters,
      implementation: (raw) => definition.run(parseToolParams(definition, raw), deps),
    }),
  );
}
