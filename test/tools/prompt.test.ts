import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { preprocessSystemPrompt } from "../../src/tools/prompt.ts";

Deno.test("preprocessSystemPrompt substitutes tool names and injects workspace path", () => {
  const raw = "Use ${ToolNames.READ_FILE} and ${ToolNames.SHELL} here.";
  const out = preprocessSystemPrompt(raw, "/workspace/.silas");
  assertStringIncludes(out, "read");
  assertStringIncludes(out, "bash");
  assertStringIncludes(out, "/workspace/.silas");
  assertStringIncludes(out, "Tool notes");
  assertStringIncludes(out, "ask_user_question");
  assertStringIncludes(out, "read-only subagent");
  assertStringIncludes(out, "`agent`");
  assertEquals(out.includes("not implemented"), false);
  assertStringIncludes(out, "`skill`");
  assertEquals(out.includes("`todo_write`"), false);
});
