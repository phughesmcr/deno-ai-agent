const TOOL_NAME_MAP: Record<string, string> = {
  "ToolNames.READ_FILE": "read",
  "ToolNames.WRITE_FILE": "write",
  "ToolNames.EDIT": "edit",
  "ToolNames.SHELL": "bash",
  "ToolNames.BASH": "bash",
  "ToolNames.GREP": "grep",
  "ToolNames.GLOB": "find",
  "ToolNames.FIND": "find",
  "ToolNames.LS": "ls",
  "ToolNames.TODO_WRITE": "todo_write",
  "ToolNames.ASK_USER_QUESTION": "ask_user_question",
  "ToolNames.SKILL": "skill",
  "ToolNames.AGENT": "agent",
};

const TOOL_NOTES = `
## Tool notes

Use \`ask_user_question\` for structured multiple-choice clarification via Telegram inline keyboards.
Use \`agent\` to spawn asynchronous read-only subagent jobs for research. Subagents can inspect with \`read\`, \`grep\`, \`find\`, \`ls\`, and \`skill\`; they cannot mutate files, run shell commands, ask the user, manage todos, or spawn agents.
File and shell tools have **no** runtime confirmation gate.
`;

/**
 * Substitutes template tool names and injects workspace path for the system prompt.
 */
export function preprocessSystemPrompt(raw: string, workspacePath: string): string {
  let result = raw;
  for (const [placeholder, name] of Object.entries(TOOL_NAME_MAP)) {
    result = result.replaceAll(`\${${placeholder}}`, name);
  }
  result = result.replaceAll("${ToolNames.READ_FILE}", "read");
  result = result.replaceAll("${ToolNames.WRITE_FILE}", "write");
  result = result.replaceAll("${ToolNames.EDIT}", "edit");
  result = result.replaceAll("${ToolNames.SHELL}", "bash");
  result = result.replaceAll("${ToolNames.GREP}", "grep");
  result = result.replaceAll("${ToolNames.GLOB}", "find");
  result = result.replaceAll("${ToolNames.TODO_WRITE}", "todo_write");
  result = result.replaceAll("${ToolNames.ASK_USER_QUESTION}", "ask_user_question");
  result = result.replaceAll("${ToolNames.SKILL}", "skill");
  result = result.replaceAll("${ToolNames.AGENT}", "agent");

  const workspaceNote =
    `\nTool workspace root (all file/shell tool paths must resolve inside this directory): \`${workspacePath}\`\n`;

  const firstNewline = result.indexOf("\n");
  if (firstNewline === -1) {
    result = result + workspaceNote;
  } else {
    result = result.slice(0, firstNewline + 1) + workspaceNote + result.slice(firstNewline + 1);
  }

  if (!result.includes("Tool notes")) {
    result += TOOL_NOTES;
  }

  return result;
}
