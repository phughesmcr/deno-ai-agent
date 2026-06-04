import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createSkillManager } from "../../src/agent/skills/mod.ts";
import {
  approvalRequestForToolCall,
  createToolCallGuard,
  type ToolAuthorizationDeps,
  type ToolCallGuardController,
} from "../../src/agent/tools/authorization.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
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
      allowAndOverrideParameters: () => decisions.push("override"),
    },
  };
}

async function withAuthDeps(
  fn: (deps: ToolAuthorizationDeps, captured: ApprovalRequest[]) => Promise<void>,
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
      todos: {
        getSessionId: () => "00000000-0000-4000-8000-000000000000",
        todosDir: `${root}/todos`,
      },
      skills: { manager: skills },
    }, captured);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("approvalRequestForToolCall maps workspace and host file risks", async () => {
  await withAuthDeps(async (deps) => {
    const outside = await Deno.makeTempDir({ prefix: "silas-tool-auth-host-" });
    try {
      const workspaceRead = await approvalRequestForToolCall(deps, {
        name: "read",
        arguments: { path: "README.md", offset: 2, limit: 4 },
      });
      assertEquals(workspaceRead?.operation, "read");
      assertEquals(workspaceRead?.target, "README.md");
      assertEquals(workspaceRead?.risk, "low");
      assertEquals(workspaceRead?.summary, "read text with offset=2, limit=4");
      assertEquals(workspaceRead?.sessionId, "session-1");
      assertEquals(workspaceRead?.turnId, "turn-1");

      const hostWrite = await approvalRequestForToolCall(deps, {
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

Deno.test("approvalRequestForToolCall maps shell network todo and skill summaries", async () => {
  await withAuthDeps(async (deps) => {
    await Deno.mkdir(`${deps.workspace.root}/skills/docs`, { recursive: true });
    await Deno.writeTextFile(
      `${deps.workspace.root}/skills/docs/SKILL.md`,
      "---\nname: docs\ndescription: Docs\n---\nBody",
    );
    await deps.skills.manager.refresh();

    const bash = await approvalRequestForToolCall(deps, {
      name: "bash",
      arguments: { command: "deno test" },
    });
    assertEquals(bash?.operation, "shell");
    assertEquals(bash?.target, "deno test");
    assertEquals(bash?.risk, "high");
    assertEquals(bash?.summary, `cwd=${deps.workspace.root}`);

    const repl = await approvalRequestForToolCall(deps, {
      name: "typescript-repl",
      arguments: { typescript: "console.log(1)", timeout: 9 },
    });
    assertEquals(repl?.operation, "shell");
    assertEquals(repl?.target, "typescript-repl");
    assertEquals(repl?.summary, "run typescript, timeout=9s, 14 bytes");

    const network = await approvalRequestForToolCall(deps, {
      name: "web-fetch",
      arguments: { url: "https://example.com/a/b?secret=true" },
    });
    assertEquals(network?.operation, "network");
    assertEquals(network?.target, "https://example.com");
    assertEquals(network?.summary, "GET /a/b");

    const todo = await approvalRequestForToolCall(deps, {
      name: "todo_write",
      arguments: { todos: [{ id: "a", content: "Do it", status: "pending" }] },
    });
    assertEquals(todo?.operation, "todo");
    assertEquals(todo?.target, "todos/00000000-0000-4000-8000-000000000000.json");
    assertEquals(todo?.summary, "write 1 todo item(s)");

    const skill = await approvalRequestForToolCall(deps, {
      name: "skill",
      arguments: { skill: "docs" },
    });
    assertEquals(skill?.operation, "skill");
    assertEquals(skill?.target, "skills/docs/SKILL.md");
    assertEquals(skill?.summary, "activate skill docs");
  });
});

Deno.test("createToolCallGuard allows approved requests and denies declined requests", async () => {
  await withAuthDeps(async (deps, captured) => {
    const guard = createToolCallGuard(deps);
    const approved = decisionController("bash", { command: "echo ok" });

    await guard(0, 1, approved.controller);

    assertEquals(approved.decisions, ["allow"]);
    assertEquals(captured[0]?.operation, "shell");
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

Deno.test("createToolCallGuard auto-allows user question and subagent tools", async () => {
  await withAuthDeps(async (deps, captured) => {
    const guard = createToolCallGuard(deps);
    const question = decisionController("ask_user_question", {});
    const subagent = decisionController("subagent", {});

    await guard(0, 1, question.controller);
    await guard(0, 2, subagent.controller);

    assertEquals(question.decisions, ["allow"]);
    assertEquals(subagent.decisions, ["allow"]);
    assertEquals(captured, []);
  });
});

Deno.test("createToolCallGuard denies authorization resolution errors", async () => {
  await withAuthDeps(async (deps) => {
    const guard = createToolCallGuard(deps);
    const invalid = decisionController("web-fetch", { url: "file:///tmp/nope" });

    await guard(0, 1, invalid.controller);

    assertEquals(invalid.decisions.length, 1);
    assertStringIncludes(invalid.decisions[0] ?? "", "Tool call denied");
    assertStringIncludes(invalid.decisions[0] ?? "", "http: and https:");
  });
});

Deno.test("createToolCallGuard queues overlapping approval requests through the gate", async () => {
  await withAuthDeps(async (deps) => {
    const events: string[] = [];
    let tail = Promise.resolve();
    deps.approvalGate = {
      requestApproval(request): Promise<ApprovalDecision> {
        const current = tail.then(async () => {
          events.push(`start:${request.operation}:${request.target}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(`end:${request.operation}:${request.target}`);
          return approveDecision("test");
        });
        tail = current.then(() => undefined);
        return current;
      },
    };
    const guard = createToolCallGuard(deps);
    const first = decisionController("bash", { command: "echo first" });
    const second = decisionController("web-fetch", { url: "https://example.com/" });

    await Promise.all([
      guard(0, 1, first.controller),
      guard(0, 2, second.controller),
    ]);

    assertEquals(events, [
      "start:shell:echo first",
      "end:shell:echo first",
      "start:network:https://example.com",
      "end:network:https://example.com",
    ]);
    assertEquals(first.decisions, ["allow"]);
    assertEquals(second.decisions, ["allow"]);
  });
});
