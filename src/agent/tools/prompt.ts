const TOOL_NAME_MAP: Record<string, string> = {
  "ToolNames.READ_FILE": "read",
  "ToolNames.WRITE_FILE": "write",
  "ToolNames.EDIT": "edit",
  "ToolNames.SHELL": "bash",
  "ToolNames.BASH": "bash",
  "ToolNames.TYPESCRIPT_REPL": "typescript-repl",
  "ToolNames.GREP": "grep",
  "ToolNames.GLOB": "find",
  "ToolNames.FIND": "find",
  "ToolNames.LS": "ls",
  "ToolNames.TODO_WRITE": "todo_write",
  "ToolNames.WEB_FETCH": "web-fetch",
  "ToolNames.ASK_USER_QUESTION": "ask_user_question",
  "ToolNames.SKILL": "skill",
  "ToolNames.SUBAGENT": "subagent",
};

const TOOL_NOTES = `
## Tool notes

Replies are delivered to Telegram after the full turn completes; use \`todo_write\` for live progress.
Be ambitious: use tools to finish work, not just to explain it.
Use \`ask_user_question\` for structured multiple-choice clarification.
Use \`web-fetch\` for approved HTTP/HTTPS website pages instead of \`bash\`/curl.
Use \`subagent\` to spawn asynchronous read-only subagent jobs for research. Subagents can inspect with \`read\`, \`grep\`, \`find\`, \`ls\`, and \`skill\`; they cannot mutate files, run shell commands, ask the user, manage todos, or spawn subagents.
File and shell tools have **no** runtime confirmation gate within the workspace.
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
    `\nTool workspace root: \`${workspacePath}\`. This is your home — read, write, and create freely here. ` +
    `Relative paths (and absolutes under this directory) are workspace-scoped. ` +
    `For host paths outside it (e.g. \`~/.codex/config.toml\`), use \`read\`, \`write\`, \`edit\`, \`ls\`, \`grep\`, or \`find\` with an absolute or \`~/\` path (Telegram approval required). ` +
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

  const prepend = Deno.env.get("PREPEND_SYSTEM_PROMPT");
  if (prepend) result = prepend + result;

  return result;
}
