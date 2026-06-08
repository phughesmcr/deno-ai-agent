import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { createSkillManager } from "../../src/agent/skills/mod.ts";
import {
  createReadOnlySubagentTools,
  type SubagentPort,
  type SubagentRecord,
  type SubagentSpawnSpec,
} from "../../src/agent/subagents.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
import { createSubagentTool, type SubagentAction } from "../../src/agent/tools/subagent.ts";
import { runTool } from "./helpers.ts";

class FakeSubagentPort implements SubagentPort {
  readonly spawnCalls: SubagentSpawnSpec[] = [];
  readonly cancelledIds: string[] = [];
  records = new Map<string, SubagentRecord>();

  spawn(spec: SubagentSpawnSpec): Promise<SubagentRecord> {
    this.spawnCalls.push(spec);
    const record = subagentRecord({
      id: "spawned-subagent",
      title: spec.title ?? "Spawned",
      task: spec.task,
      status: "queued",
    });
    this.records.set(record.id, record);
    return Promise.resolve(record);
  }

  status(agentId: string): Promise<SubagentRecord | undefined> {
    return Promise.resolve(this.records.get(agentId));
  }

  list(): Promise<SubagentRecord[]> {
    return Promise.resolve([...this.records.values()]);
  }

  result(agentId: string): Promise<SubagentRecord | undefined> {
    return Promise.resolve(this.records.get(agentId));
  }

  cancel(agentId: string): Promise<SubagentRecord | undefined> {
    this.cancelledIds.push(agentId);
    return Promise.resolve(this.records.get(agentId));
  }
}

type SubagentToolJson =
  | { ok: true; action: SubagentAction; subagent: SubagentRecord }
  | { ok: true; action: "list"; subagents: SubagentRecord[] }
  | { ok: false; action: SubagentAction | string; error: string };

function parseJson(text: string): SubagentToolJson {
  return JSON.parse(text) as SubagentToolJson;
}

function subagentRecord(overrides: Partial<SubagentRecord>): SubagentRecord {
  return {
    id: "subagent-1",
    sessionId: "session-1",
    title: "Subagent",
    task: "Inspect",
    status: "queued",
    createdAt: "2026-01-02T03:04:05.000Z",
    ...overrides,
  };
}

function requireSubagent(response: SubagentToolJson): SubagentRecord {
  if (!response.ok || !("subagent" in response)) {
    throw new Error(`Expected subagent response: ${JSON.stringify(response)}`);
  }
  return response.subagent;
}

function requireSubagents(response: SubagentToolJson): SubagentRecord[] {
  if (!response.ok || !("subagents" in response)) {
    throw new Error(`Expected subagents response: ${JSON.stringify(response)}`);
  }
  return response.subagents;
}

function requireError(response: SubagentToolJson): string {
  if (response.ok) throw new Error(`Expected error response: ${JSON.stringify(response)}`);
  return response.error;
}

Deno.test("subagent tool validates required parameters and unknown ids", async () => {
  const port = new FakeSubagentPort();
  const tool = createSubagentTool(port);

  assertEquals(
    parseJson(await runTool(tool, { action: "spawn" })),
    { ok: false, action: "spawn", error: 'Parameter "task" is required for spawn.' },
  );

  const requiredSubagentIdResponses = await Promise.all(
    (["status", "result", "cancel"] as const).map(async (action) => ({
      action,
      response: parseJson(await runTool(tool, { action })),
    })),
  );
  for (const { action, response } of requiredSubagentIdResponses) {
    assertEquals(
      response,
      { ok: false, action, error: 'Parameter "subagent_id" is required for this action.' },
    );
  }

  const unknown = parseJson(await runTool(tool, { action: "status", subagent_id: "missing-subagent" }));
  assertStringIncludes(requireError(unknown), "Unknown subagent_id");

  const unknownAction = parseJson(await runTool(tool, { action: "pause" }));
  assertEquals(unknownAction.ok, false);
  assertEquals(unknownAction.action, "pause");
  assertStringIncludes(requireError(unknownAction), 'Parameter "action" must be one of');
});

Deno.test("subagent tool delegates actions to the SubagentPort", async () => {
  const port = new FakeSubagentPort();
  const completed = subagentRecord({
    id: "completed-subagent",
    status: "completed",
    result: "done",
  });
  port.records.set(completed.id, completed);
  const tool = createSubagentTool(port);

  const spawned = requireSubagent(parseJson(
    await runTool(tool, { action: "spawn", task: "  Inspect repo  ", title: "  Repo check  " }),
  ));
  assertEquals(spawned.status, "queued");
  assertEquals(port.spawnCalls, [{ task: "Inspect repo", title: "Repo check" }]);

  const status = requireSubagent(parseJson(
    await runTool(tool, { action: "status", subagent_id: completed.id }),
  ));
  assertEquals(status, completed);

  const result = requireSubagent(parseJson(
    await runTool(tool, { action: "result", subagent_id: completed.id }),
  ));
  assertEquals(result.result, "done");

  const cancelled = requireSubagent(parseJson(
    await runTool(tool, { action: "cancel", subagent_id: completed.id }),
  ));
  assertEquals(cancelled, completed);
  assertEquals(port.cancelledIds, [completed.id]);

  const list = requireSubagents(parseJson(await runTool(tool, { action: "list" })));
  assertEquals(list.map((record) => record.id).toSorted(), ["completed-subagent", "spawned-subagent"]);
});

Deno.test("createReadOnlySubagentTools exposes only read-only child tools", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-subagent-tools-" });
  try {
    const ctx = await createToolContext(dir, {
      sessionId: "session-1",
      turnId: "subagent-tool-test",
    });
    const skills = await createSkillManager({ root: ctx.root });
    const tools = createReadOnlySubagentTools(ctx, skills) as Array<{ name: string }>;
    const names = tools.map((item) => item.name).toSorted();

    assertEquals(names, ["find", "grep", "ls", "read", "skill"]);
    assertEquals(names.includes("write"), false);
    assertEquals(names.includes("edit"), false);
    assertEquals(names.includes("bash"), false);
    assertEquals(names.includes("todo_write"), false);
    assertEquals(names.includes("ask_user_question"), false);
    assertEquals(names.includes("subagent"), false);

    const outside = await Deno.makeTempDir({ prefix: "silas-subagent-host-" });
    try {
      await Deno.writeTextFile(`${outside}/secret.txt`, "secret");
      const read = tools.find((item) => item.name === "read");
      const output = await runTool(read, { path: `${outside}/secret.txt` });
      assertStringIncludes(output, "Error: Host paths are not available in this tool context.");
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
