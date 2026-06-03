import { assertEquals } from "jsr:@std/assert@1";

import { createSkillManager } from "../../src/agent/skills/mod.ts";
import { allToolNames, getModelTools } from "../../src/agent/tools/index.ts";
import { createNoopTodoDisplayPort } from "../../src/agent/tools/todo-display-port.ts";
import { createUnavailableAskUserQuestionPort } from "../../src/agent/tools/user-question-port.ts";
import { createUnavailableSubagentPort } from "../../src/agent/subagents.ts";
import { createTestWorkspace } from "./helpers.ts";

Deno.test("getModelTools registers twelve tools including deno_repl, skill, todo_write, ask_user_question, and agent", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const skills = await createSkillManager({ root: dir });
    const tools = getModelTools({
      workspace: ctx,
      userQuestions: createUnavailableAskUserQuestionPort(),
      todos: {
        getSessionId: () => "00000000-0000-4000-8000-000000000000",
        todosDir: `${dir}/todos`,
        display: createNoopTodoDisplayPort(),
      },
      skills: {
        manager: skills,
        getSessionId: () => "00000000-0000-4000-8000-000000000000",
      },
      subagents: createUnavailableSubagentPort(),
    }) as Array<{ name: string }>;
    assertEquals(tools.length, 12);
    assertEquals(tools.map((t) => t.name).sort(), [...allToolNames].sort());
  } finally {
    await cleanup();
  }
});
