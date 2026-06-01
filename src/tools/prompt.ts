const TOOL_NAME_REPLACEMENTS: Record<string, string> = {
  "${ToolNames.READ_FILE}": "read",
  "${ToolNames.WRITE_FILE}": "write",
  "${ToolNames.EDIT}": "edit",
  "${ToolNames.SHELL}": "bash",
  "${ToolNames.GREP}": "grep",
  "${ToolNames.GLOB}": "find",
  "${ToolNames.FIND}": "find",
  "${ToolNames.LS}": "ls",
  "${ToolNames.TODO_WRITE}": "todo_write",
  "${ToolNames.ASK_USER_QUESTION}": "ask_user_question",
  "${ToolNames.SKILL}": "skill",
  "${ToolNames.AGENT}": "agent",
};

const WORKSPACE_ROOT_MARKER = "Workspace root (all tool paths must stay inside):";

/** Substitute tool name placeholders and inject workspace root into the system prompt. */
export function prepareSystemPrompt(raw: string, workspaceRoot: string): string {
  let text = raw;
  for (const [placeholder, name] of Object.entries(TOOL_NAME_REPLACEMENTS)) {
    text = text.replaceAll(placeholder, name);
  }

  const injection = `${WORKSPACE_ROOT_MARKER} ${workspaceRoot}\n\n`;
  const headerEnd = text.indexOf("\n\n");
  if (headerEnd === -1) return `${text}\n\n${injection.trim()}`;
  return `${text.slice(0, headerEnd + 2)}${injection}${text.slice(headerEnd + 2)}`;
}

/** Resolved tool names for system prompt substitution. */
export const ToolNames = {
  READ_FILE: "read",
  WRITE_FILE: "write",
  EDIT: "edit",
  SHELL: "bash",
  GREP: "grep",
  GLOB: "find",
  FIND: "find",
  LS: "ls",
  TODO_WRITE: "todo_write",
  ASK_USER_QUESTION: "ask_user_question",
  SKILL: "skill",
  AGENT: "agent",
} as const;
