import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { preprocessSystemPrompt } from "../../src/agent/tools/prompt.ts";

Deno.test("preprocessSystemPrompt substitutes tool names and injects workspace path", () => {
  const raw = "Use ${ToolNames.READ_FILE}, ${ToolNames.SHELL}, and ${ToolNames.WEB_FETCH} here.";
  const out = preprocessSystemPrompt(raw, "/workspace/.silas");
  assertStringIncludes(out, "read");
  assertStringIncludes(out, "bash");
  assertStringIncludes(out, "web-fetch");
  assertStringIncludes(out, "/workspace/.silas");
  assertStringIncludes(out, "your home");
  assertStringIncludes(out, "Be ambitious");
  assertStringIncludes(out, "Tool notes");
  assertStringIncludes(out, "ask_user_question");
  assertStringIncludes(out, "read-only subagent");
  assertStringIncludes(out, "`subagent`");
  assertStringIncludes(out, "`web-fetch`");
  assertEquals(out.includes("not implemented"), false);
  assertStringIncludes(out, "`skill`");
  assertStringIncludes(out, "`todo_write`");
});

Deno.test("preprocessSystemPrompt prepends PREPEND_SYSTEM_PROMPT when set", () => {
  const key = "PREPEND_SYSTEM_PROMPT";
  const previous = Deno.env.get(key);
  try {
    Deno.env.set(key, "<|think|>");
    const out = preprocessSystemPrompt("body", "/workspace/.silas");
    assertEquals(out.startsWith("<|think|>"), true);
    assertStringIncludes(out, "body");
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
});
