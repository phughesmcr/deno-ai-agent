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

Use \`ask_user_question\` for structured multiple-choice clarification.
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

  const workspaceNote =
    `\nTool workspace root: \`${workspacePath}\`. Relative paths (and absolutes under this directory) are sandboxed. ` +
    `To read host files outside it (e.g. \`~/.codex/config.toml\`), use \`read\` with an absolute or \`~/\` path (approval required). ` +
    "`bash` runs with this directory as cwd.\n";

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
