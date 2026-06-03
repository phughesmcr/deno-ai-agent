import type { Tool } from "@lmstudio/sdk";

import { createAgentTool } from "./agent.ts";
import { createAskUserQuestionTool } from "./ask-user-question.ts";
import { createBashTool } from "./bash.ts";
import { createToolContext, type ToolContext } from "./context.ts";
import { createDenoReplTool } from "./deno-repl.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createSkillTool } from "./skill.ts";
import { createNoopTodoDisplayPort } from "./todo-display-port.ts";
import { createTodoWriteTool, type TodoWriteDeps } from "./todo-write.ts";
import { type AskUserQuestionPort, createUnavailableAskUserQuestionPort } from "./user-question-port.ts";
import { createWriteTool } from "./write.ts";
import { createSkillManager, type SkillManager } from "../skills/mod.ts";
import { createUnavailableSubagentPort, type SubagentPort } from "../subagents.ts";

export { createToolContext, normalizeRoot } from "./context.ts";
export type { ToolContext, ToolContextOptions } from "./context.ts";
export { preprocessSystemPrompt } from "./prompt.ts";
export { createNoopTodoDisplayPort } from "./todo-display-port.ts";
export type { TodoDisplayPort, TodoUpdatePayload } from "./todo-display-port.ts";
export {
  type AskUserQuestionParams,
  createAskUserQuestionTool,
  formatAnswers,
  type Question,
  type QuestionOption,
  UserQuestionAbortedError,
  UserQuestionDeclinedError,
  validateAskUserQuestionParams,
} from "./ask-user-question.ts";
export {
  type AskUserQuestionPort,
  createUnavailableAskUserQuestionPort,
  type TurnTarget,
} from "./user-question-port.ts";
export { createAgentTool } from "./agent.ts";
export type { AgentAction, AgentToolParams, AgentToolResponse } from "./agent.ts";
export { createDenoReplTool } from "./deno-repl.ts";
export { getShellCommand } from "./shell-command.ts";
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
export { createUnavailableSubagentPort } from "../subagents.ts";
export type { SubagentPort, SubagentRecord, SubagentStatus } from "../subagents.ts";

/** Pi-aligned tool identifiers registered with the model. */
export type ToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "deno_repl"
  | "grep"
  | "find"
  | "ls"
  | "skill"
  | "todo_write"
  | "ask_user_question"
  | "agent";

/** All tool names in registration order. */
export const allToolNames: ToolName[] = [
  "read",
  "write",
  "edit",
  "bash",
  "deno_repl",
  "grep",
  "find",
  "ls",
  "skill",
  "todo_write",
  "ask_user_question",
  "agent",
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
}

/** Returns all coding tools for the given workspace root. */
export function getModelTools(deps: ModelToolDeps): Tool[] {
  return [
    createReadTool(deps.workspace),
    createWriteTool(deps.workspace),
    createEditTool(deps.workspace),
    createBashTool(deps.workspace),
    createDenoReplTool(deps.workspace),
    createGrepTool(deps.workspace),
    createFindTool(deps.workspace),
    createLsTool(deps.workspace),
    createSkillTool(deps.skills.manager, deps.workspace),
    createTodoWriteTool({ ...deps.todos, workspace: deps.workspace }),
    createAskUserQuestionTool(deps.userQuestions),
    createAgentTool(deps.subagents),
  ];
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
