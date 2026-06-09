import type { Tool } from "@lmstudio/sdk";
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createSkillManager } from "../../src/agent/skills/mod.ts";
import { createUnavailableSubagentPort } from "../../src/agent/subagents.ts";
import {
  type AgentToolDeps,
  authorizeToolCall,
  createToolCallGuard,
  type ToolCallGuardController,
} from "../../src/agent/tools/mod.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
import { createNoopTodoDisplayPort } from "../../src/agent/tools/todo-display-port.ts";
import type { TodoStore } from "../../src/agent/tools/todo-store.ts";
import { createUnavailableUserInteractionPort } from "../../src/agent/tools/user-question-port.ts";
import type { CapabilityDecisionResult, CapabilityRequest } from "../../src/core/mod.ts";

function unavailableTodoStore(): TodoStore {
  const unavailable = (): Promise<never> => Promise.reject(new Error("Todo store is not configured."));
  return {
    read: unavailable,
    write: unavailable,
    updateTodos: unavailable,
    updateTelegramMeta: unavailable,
    copy: unavailable,
    label: (sessionId) => `workspace-kv:todos/${sessionId}`,
  };
}

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
  fn: (deps: AgentToolDeps, captured: CapabilityRequest[]) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "silas-tool-auth-" });
  const captured: CapabilityRequest[] = [];
  try {
    const workspace = await createToolContext(root, {
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const skills = await createSkillManager({ root });
    await fn({
      workspace,
      userQuestions: createUnavailableUserInteractionPort(),
      todos: {
        getSessionId: () => "00000000-0000-4000-8000-000000000000",
        store: unavailableTodoStore(),
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
      assertEquals(workspaceRead?.source, "local_tool");
      assertEquals(workspaceRead?.capability, { kind: "local_tool", target: "README.md", action: "read" });
      assertEquals(workspaceRead?.risk, "low");
      assertEquals(workspaceRead?.summary, "read text with offset=2, limit=4");
      assertEquals(workspaceRead?.sessionId, "session-1");
      assertEquals(workspaceRead?.workId, "turn-1");

      const hostWrite = await authorizeToolCall(deps, {
        name: "write",
        arguments: { path: `${outside}/notes.txt`, content: "hello" },
      });
      assertEquals(hostWrite?.source, "local_tool");
      assertEquals(hostWrite?.capability, { kind: "local_tool", target: `${outside}/notes.txt`, action: "write" });
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
    assertEquals(bash?.capability, { kind: "local_tool", target: "deno test", action: "shell" });
    assertEquals(bash?.risk, "high");
    assertEquals(bash?.summary, `cwd=${deps.workspace.root}`);

    const repl = await authorizeToolCall(deps, {
      name: "typescript-repl",
      arguments: { typescript: "console.log(1)", timeout: 9 },
    });
    assertEquals(repl?.capability, { kind: "local_tool", target: "typescript-repl", action: "shell" });
    assertEquals(repl?.summary, "run typescript, timeout=9s, 14 bytes");

    const network = await authorizeToolCall(deps, {
      name: "web-fetch",
      arguments: { url: "https://example.com/a/b?secret=true" },
    });
    assertEquals(network?.capability, { kind: "local_tool", target: "https://example.com", action: "network" });
    assertEquals(network?.summary, "GET /a/b");

    const todo = await authorizeToolCall(deps, {
      name: "todo_write",
      arguments: { todos: [{ id: "a", content: "Do it", status: "pending" }] },
    });
    assertEquals(todo?.capability, {
      kind: "local_tool",
      target: "workspace-kv:todos/00000000-0000-4000-8000-000000000000",
      action: "todo",
    });
    assertEquals(todo?.summary, "write 1 todo item(s)");

    const skill = await authorizeToolCall(deps, {
      name: "skill",
      arguments: { skill: "docs" },
    });
    assertEquals(skill?.capability, { kind: "local_tool", target: "skills/docs/SKILL.md", action: "skill" });
    assertEquals(skill?.summary, "activate skill docs");
  });
});

Deno.test("tool call guard overrides approved local parameters and denies declined requests", async () => {
  await withAuthDeps(async (deps, captured) => {
    const guard = createToolCallGuard(deps, {
      decide(request): Promise<CapabilityDecisionResult> {
        captured.push(request);
        return Promise.resolve({
          allowed: true,
          reason: "approved",
          scope: "once",
          source: "prompt",
          grant: "once",
        });
      },
    });
    const approved = decisionController("ls", {});

    await guard(0, 1, approved.controller);

    assertEquals(approved.decisions, ["override:{}"]);
    assertEquals(captured[0]?.capability.action, "list");
  });

  await withAuthDeps(async (deps) => {
    const guard = createToolCallGuard(deps, {
      decide: () =>
        Promise.resolve({
          allowed: false,
          reason: "user_denied",
          scope: "once",
          source: "prompt",
        }),
    });
    const denied = decisionController("bash", { command: "echo no" });

    await guard(0, 1, denied.controller);

    assertEquals(denied.decisions, ["deny:Tool call denied: user_denied"]);
  });
});

Deno.test("tool call guard auto-allows user question and subagent tools without approval gate", async () => {
  await withAuthDeps(async (deps, captured) => {
    const guard = createToolCallGuard(deps, {
      decide(request): Promise<CapabilityDecisionResult> {
        captured.push(request);
        return Promise.resolve({
          allowed: true,
          reason: "approved",
          scope: "once",
          source: "prompt",
          grant: "once",
        });
      },
    });
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
    deps.mcp = {
      getTools: () => [{ name: "mcp__docs__search" } as unknown as Tool],
    };
    const guard = createToolCallGuard(deps, {
      decide(request): Promise<CapabilityDecisionResult> {
        captured.push(request);
        return Promise.resolve({
          allowed: true,
          reason: "approved",
          scope: "once",
          source: "prompt",
          grant: "once",
        });
      },
    });
    const mcp = decisionController("mcp__docs__search", { query: "agent" });
    const unknown = decisionController("missing_tool", {});
    const invalid = decisionController("web-fetch", { url: "file:///tmp/nope" });

    await guard(0, 1, mcp.controller);
    await guard(0, 2, unknown.controller);
    await guard(0, 3, invalid.controller);

    assertEquals(mcp.decisions, ["allow"]);
    assertEquals(captured[0]?.source, "mcp_tool");
    assertEquals(captured[0]?.capability, { kind: "mcp_tool", target: "docs/search", action: "call" });
    assertEquals(captured[0]?.risk, "high");
    assertEquals(captured.length, 1);

    assertStringIncludes(unknown.decisions[0] ?? "", "No authorization policy");
    assertStringIncludes(invalid.decisions[0] ?? "", "http: and https:");
  });
});

Deno.test("tool call guard only authorizes exposed MCP tools", async () => {
  await withAuthDeps(async (deps, captured) => {
    deps.mcp = {
      getTools: () => [{ name: "mcp__docs__search" } as unknown as Tool],
    };
    const guard = createToolCallGuard(deps, {
      decide(request): Promise<CapabilityDecisionResult> {
        captured.push(request);
        return Promise.resolve({
          allowed: true,
          reason: "approved",
          scope: "once",
          source: "prompt",
          grant: "once",
        });
      },
    });
    const exposed = decisionController("mcp__docs__search", { query: "agent" });
    const unexposed = decisionController("mcp__docs__missing", {});

    await guard(0, 1, exposed.controller);
    await guard(0, 2, unexposed.controller);

    assertEquals(exposed.decisions, ["allow"]);
    assertEquals(captured[0]?.source, "mcp_tool");
    assertEquals(captured[0]?.capability.target, "docs/search");
    assertStringIncludes(unexposed.decisions[0] ?? "", "No authorization policy");
  });
});
