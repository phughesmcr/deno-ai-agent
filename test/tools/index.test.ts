import { assertEquals } from "jsr:@std/assert@1";

import { createSkillManager } from "../../src/agent/skills/mod.ts";
import { allToolNames, getModelTools } from "../../src/agent/tools/index.ts";
import { createNoopTodoDisplayPort } from "../../src/agent/tools/todo-display-port.ts";
import { createUnavailableAskUserQuestionPort } from "../../src/agent/tools/user-question-port.ts";
import { createAutoApprovalGate } from "../../src/shared/approval.ts";
import { createUnavailableSubagentPort } from "../../src/agent/subagents.ts";
import { createTestWorkspace } from "./helpers.ts";

Deno.test("getModelTools registers thirteen tools including typescript-repl, skill, todo_write, web-fetch, ask_user_question, and subagent", async () => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    const skills = await createSkillManager({ root: dir });
    const tools = getModelTools({
      workspace: ctx,
      approvalGate: createAutoApprovalGate("test"),
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
    assertEquals(tools.length, 13);
    assertEquals(tools.map((t) => t.name).sort(), [...allToolNames].sort());
  } finally {
    await cleanup();
  }
});
