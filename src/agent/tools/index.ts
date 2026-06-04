import type { Tool } from "@lmstudio/sdk";

import { createSkillManager, type SkillManager } from "../skills/mod.ts";
import { createUnavailableSubagentPort, type SubagentPort } from "../subagents.ts";
import { createAskUserQuestionTool } from "./ask-user-question.ts";
import { createToolCallGuard, type ToolAuthorizationDeps, type ToolCallGuard } from "./authorization.ts";
import { createBashTool } from "./bash.ts";
import { createToolContext, type ToolContext } from "./context.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createSkillTool } from "./skill.ts";
import { createSubagentTool } from "./subagent.ts";
import { createNoopTodoDisplayPort } from "./todo-display-port.ts";
import { createTodoWriteTool, type TodoWriteDeps } from "./todo-write.ts";
import { withRecoverableToolErrors } from "./tool-errors.ts";
import { createTypeScriptReplTool } from "./typescript-repl.ts";
import { type AskUserQuestionPort, createUnavailableAskUserQuestionPort } from "./user-question-port.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import { createWriteTool } from "./write.ts";

export { createUnavailableSubagentPort } from "../subagents.ts";
export type { SubagentPort, SubagentRecord, SubagentStatus } from "../subagents.ts";
export {
  type AskUserQuestionParams,
  createAskUserQuestionTool,
  formatAnswers,
  type Question,
  type QuestionOption,
  validateAskUserQuestionParams,
} from "./ask-user-question.ts";
export {
  approvalRequestForToolCall,
  createToolCallGuard,
  type GuardedToolCallRequest,
  type ToolAuthorizationDeps,
  type ToolCallGuard,
  type ToolCallGuardController,
} from "./authorization.ts";
export { createToolContext, normalizeRoot } from "./context.ts";
export type { ToolContext, ToolContextOptions } from "./context.ts";
export { preprocessSystemPrompt, setMcpSystemPromptAppendix } from "./prompt.ts";
export { getShellCommand } from "./shell-command.ts";
export { createSubagentTool } from "./subagent.ts";
export type { SubagentAction, SubagentToolParams, SubagentToolResponse } from "./subagent.ts";
export { createNoopTodoDisplayPort } from "./todo-display-port.ts";
export type { TodoDisplayPort, TodoUpdatePayload } from "./todo-display-port.ts";
export {
  copyTodosForSession,
  createTodoWriteTool,
  detectTodoChanges,
  formatTodoWriteResult,
  readTodoFile,
  readTodosForSession,
  type TodoChanges,
  type TodoFile,
  type TodoItem,
  type TodoStatus,
  type TodoTelegramMeta,
  type TodoWriteDeps,
  type TodoWriteParams,
  updateTelegramMeta,
  validateTodoWriteParams,
  writeTodoFile,
} from "./todo-write.ts";
export { createTypeScriptReplTool } from "./typescript-repl.ts";
export {
  type UserInteractionRequest,
  type UserInteractionResult,
  UserQuestionAbortedError,
  UserQuestionDeclinedError,
} from "./user-interaction.ts";
export {
  type AskUserQuestionPort,
  createUnavailableAskUserQuestionPort,
  createUnavailableUserInteractionPort,
  type TurnTarget,
  type UserInteractionPort,
} from "./user-question-port.ts";
export { createWebFetchTool, type WebFetchToolOptions } from "./web-fetch.ts";

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

/** All tool names in registration order. */
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

/**
 * Dependencies for building the full model tool set.
 * @internal
 */
export interface ModelToolDeps {
  workspace: ToolContext;
  userQuestions: AskUserQuestionPort;
  todos: TodoWriteDeps;
  skills: {
    manager: SkillManager;
    getSessionId: () => string;
  };
  subagents: SubagentPort;
  /** Optional MCP tools (main agent turns only). */
  mcp?: { getTools(): Tool[] };
}

/** Full tool set for normal model turns, including the central approval guard. */
export interface ModelToolSet {
  tools: Tool[];
  guardToolCall: ToolCallGuard;
}

/** Returns all coding tools for the given workspace root. */
export function getModelTools(deps: ModelToolDeps): Tool[] {
  const core = [
    createReadTool(deps.workspace),
    createWriteTool(deps.workspace),
    createEditTool(deps.workspace),
    createBashTool(deps.workspace),
    createTypeScriptReplTool(deps.workspace),
    createGrepTool(deps.workspace),
    createFindTool(deps.workspace),
    createLsTool(deps.workspace),
    createSkillTool(deps.skills.manager),
    createTodoWriteTool({ ...deps.todos, workspace: deps.workspace }),
    createWebFetchTool(deps.workspace),
    createAskUserQuestionTool(deps.userQuestions),
    createSubagentTool(deps.subagents),
  ].map(withRecoverableToolErrors);
  const mcp = deps.mcp?.getTools() ?? [];
  return [...core, ...mcp];
}

/** Returns normal-turn tools plus the guard that owns app-layer tool approvals. */
export function getModelToolSet(deps: ModelToolDeps & ToolAuthorizationDeps): ModelToolSet {
  return {
    tools: getModelTools(deps),
    guardToolCall: createToolCallGuard(deps),
  };
}

/** Creates tools from a workspace directory path (canonicalizes root). */
export async function getModelToolsForRoot(root: string): Promise<Tool[]> {
  const skills = await createSkillManager({ root });
  return getModelTools({
    workspace: await createToolContext(root),
    userQuestions: createUnavailableAskUserQuestionPort(),
    todos: {
      getSessionId: () => "00000000-0000-4000-8000-000000000000",
      todosDir: `${root}/todos`,
      display: createNoopTodoDisplayPort(),
    },
    skills: {
      manager: skills,
      getSessionId: () => "00000000-0000-4000-8000-000000000000",
    },
    subagents: createUnavailableSubagentPort(),
  });
}
