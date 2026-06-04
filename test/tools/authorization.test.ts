import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createSkillManager } from "../../src/agent/skills/mod.ts";
import { createUnavailableSubagentPort } from "../../src/agent/subagents.ts";
import {
  type AgentToolDeps,
  authorizeToolCall,
  createToolCallGuard,
  type ToolCallGuardController,
} from "../../src/agent/tools/index.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
import { createNoopTodoDisplayPort } from "../../src/agent/tools/todo-display-port.ts";
import { createUnavailableAskUserQuestionPort } from "../../src/agent/tools/user-question-port.ts";
import {
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  approveDecision,
  denyDecision,
} from "../../src/shared/approval.ts";

function decisionController(toolName: string, args: Record<string, unknown>): {
  controller: ToolCallGuardController;
  decisions: string[];
} {
  const decisions: string[] = [];
  return {
    decisions,
    controller: {
      toolCallRequest: { name: toolName, arguments: args },
      allow: () => decisions.push("allow"),
      deny: (reason) => decisions.push(`deny:${reason ?? ""}`),
      allowAndOverrideParameters: (params) => decisions.push(`override:${JSON.stringify(params)}`),
    },
  };
}

async function withAuthDeps(
  fn: (deps: AgentToolDeps, captured: ApprovalRequest[]) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "silas-tool-auth-" });
  const captured: ApprovalRequest[] = [];
  const approvalGate: ApprovalGate = {
    requestApproval(request): Promise<ApprovalDecision> {
      captured.push(request);
      return Promise.resolve(approveDecision("test"));
    },
  };
  try {
    const workspace = await createToolContext(root, {
      sessionId: "session-1",
      turnId: "turn-1",
    });
    await Deno.mkdir(`${root}/todos`, { recursive: true });
    const skills = await createSkillManager({ root });
    await fn({
      workspace,
      approvalGate,
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
    }, captured);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("registry authorization maps workspace and host file risks", async () => {
  await withAuthDeps(async (deps) => {
    const outside = await Deno.makeTempDir({ prefix: "silas-tool-auth-host-" });
    try {
      await Deno.writeTextFile(`${deps.workspace.root}/README.md`, "one\ntwo\nthree\nfour\nfive");
      const workspaceRead = await authorizeToolCall(deps, {
        name: "read",
        arguments: { path: "README.md", offset: 2, limit: 4 },
      });
      assertEquals(workspaceRead?.operation, "read");
      assertEquals(workspaceRead?.target, "README.md");
      assertEquals(workspaceRead?.risk, "low");
      assertEquals(workspaceRead?.summary, "read text with offset=2, limit=4");
      assertEquals(workspaceRead?.sessionId, "session-1");
      assertEquals(workspaceRead?.turnId, "turn-1");

      const hostWrite = await authorizeToolCall(deps, {
        name: "write",
        arguments: { path: `${outside}/notes.txt`, content: "hello" },
      });
      assertEquals(hostWrite?.operation, "write");
      assertEquals(hostWrite?.target, `${outside}/notes.txt`);
      assertEquals(hostWrite?.risk, "high");
      assertEquals(hostWrite?.summary, "write 5 bytes");
      assertEquals(hostWrite?.timeoutMs, 120_000);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  });
});

Deno.test("registry authorization maps shell network todo and skill summaries", async () => {
  await withAuthDeps(async (deps) => {
    await Deno.mkdir(`${deps.workspace.root}/skills/docs`, { recursive: true });
    await Deno.writeTextFile(
      `${deps.workspace.root}/skills/docs/SKILL.md`,
      "---\nname: docs\ndescription: Docs\n---\nBody",
    );
    await deps.skills.manager.refresh();

    const bash = await authorizeToolCall(deps, {
      name: "bash",
      arguments: { command: "deno test" },
    });
    assertEquals(bash?.operation, "shell");
    assertEquals(bash?.target, "deno test");
    assertEquals(bash?.risk, "high");
    assertEquals(bash?.summary, `cwd=${deps.workspace.root}`);

    const repl = await authorizeToolCall(deps, {
      name: "typescript-repl",
      arguments: { typescript: "console.log(1)", timeout: 9 },
    });
    assertEquals(repl?.operation, "shell");
    assertEquals(repl?.target, "typescript-repl");
    assertEquals(repl?.summary, "run typescript, timeout=9s, 14 bytes");

    const network = await authorizeToolCall(deps, {
      name: "web-fetch",
      arguments: { url: "https://example.com/a/b?secret=true" },
    });
    assertEquals(network?.operation, "network");
    assertEquals(network?.target, "https://example.com");
    assertEquals(network?.summary, "GET /a/b");

    const todo = await authorizeToolCall(deps, {
      name: "todo_write",
      arguments: { todos: [{ id: "a", content: "Do it", status: "pending" }] },
    });
    assertEquals(todo?.operation, "todo");
    assertEquals(todo?.target, "todos/00000000-0000-4000-8000-000000000000.json");
    assertEquals(todo?.summary, "write 1 todo item(s)");

    const skill = await authorizeToolCall(deps, {
      name: "skill",
      arguments: { skill: "docs" },
    });
    assertEquals(skill?.operation, "skill");
    assertEquals(skill?.target, "skills/docs/SKILL.md");
    assertEquals(skill?.summary, "activate skill docs");
  });
});

Deno.test("tool call guard overrides approved local parameters and denies declined requests", async () => {
  await withAuthDeps(async (deps, captured) => {
    const guard = createToolCallGuard(deps);
    const approved = decisionController("ls", {});

    await guard(0, 1, approved.controller);

    assertEquals(approved.decisions, ["override:{}"]);
    assertEquals(captured[0]?.operation, "list");
  });

  await withAuthDeps(async (deps) => {
    deps.approvalGate = {
      requestApproval: () => Promise.resolve(denyDecision("user_denied")),
    };
    const guard = createToolCallGuard(deps);
    const denied = decisionController("bash", { command: "echo no" });

    await guard(0, 1, denied.controller);

    assertEquals(denied.decisions, ["deny:Tool call denied: user_denied"]);
  });
});

Deno.test("tool call guard auto-allows user question and subagent tools without approval gate", async () => {
  await withAuthDeps(async (deps, captured) => {
    const guard = createToolCallGuard(deps);
    const question = decisionController("ask_user_question", {
      questions: [{
        question: "Choose?",
        header: "Choice",
        options: [{ label: "A", description: "A" }, {
          label: "B",
          description: "B",
        }],
      }],
    });
    const subagent = decisionController("subagent", { action: "list" });

    await guard(0, 1, question.controller);
    await guard(0, 2, subagent.controller);

    assertStringIncludes(question.decisions[0] ?? "", "override:");
    assertEquals(subagent.decisions, ['override:{"action":"list"}']);
    assertEquals(captured, []);
  });
});

Deno.test("tool call guard handles MCP fallback, unknown tools, and invalid arguments", async () => {
  await withAuthDeps(async (deps, captured) => {
    const guard = createToolCallGuard(deps);
    const mcp = decisionController("mcp__docs__search", { query: "agent" });
    const unknown = decisionController("missing_tool", {});
    const invalid = decisionController("web-fetch", { url: "file:///tmp/nope" });

    await guard(0, 1, mcp.controller);
    await guard(0, 2, unknown.controller);
    await guard(0, 3, invalid.controller);

    assertEquals(mcp.decisions, ["allow"]);
    assertEquals(captured[0]?.operation, "mcp");
    assertEquals(captured[0]?.target, "docs/search");
    assertEquals(captured[0]?.risk, "high");

    assertStringIncludes(unknown.decisions[0] ?? "", "No authorization policy");
    assertStringIncludes(invalid.decisions[0] ?? "", "http: and https:");
  });
});
