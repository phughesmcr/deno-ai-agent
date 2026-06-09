import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  createDurableUserInteractionPort,
  type DurableUserInteractionPort,
  listPendingInteractions,
} from "../../src/core/mod.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

interface TestRequest {
  mode: "cursor_questions";
  prompt: string;
}

interface TestResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

function testPort(result: TestResult): DurableUserInteractionPort<unknown, TestRequest, TestResult> {
  return {
    isAvailable: () => true,
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    interact: () => Promise.resolve(result),
  };
}

Deno.test("durable user interaction port records requested and completed events", async () => {
  const events = new MemoryKernelStore();
  const port = createDurableUserInteractionPort({
    events,
    delegate: testPort({ action: "accept", content: { "0": "Yes" } }),
    getSessionId: () => "session-1",
    getWorkId: () => "work-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    createInteractionId: () => "interaction-1",
  });

  const result = await port.interact({ mode: "cursor_questions", prompt: "Continue?" });

  assertEquals(result, { action: "accept", content: { "0": "Yes" } });
  assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
    "interaction.requested",
    "interaction.completed",
  ]);
  assertEquals(await listPendingInteractions(events), []);
});

Deno.test("durable user interaction port records failed completion before rethrowing", async () => {
  const events = new MemoryKernelStore();
  const port = createDurableUserInteractionPort({
    events,
    delegate: {
      ...testPort({ action: "cancel" }),
      interact: () => Promise.reject(new Error("user flow failed")),
    },
    getSessionId: () => "session-1",
    getWorkId: () => "work-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    createInteractionId: () => "interaction-1",
  });

  await assertRejects(
    () => port.interact({ mode: "cursor_questions", prompt: "Continue?" }),
    Error,
    "user flow failed",
  );

  const completed = (await events.listByWork("work-1")).at(-1);
  assertEquals(completed?.category, "interaction.completed");
  assertEquals(completed?.payload, {
    interactionId: "interaction-1",
    status: "failed",
    error: { name: "Error", message: "user flow failed" },
    completedAt: "2026-01-01T00:00:00.000Z",
  });
  assertEquals(await listPendingInteractions(events), []);
});

Deno.test("listPendingInteractions replays unmatched interaction requests", async () => {
  const events = new MemoryKernelStore();
  await events.append({
    category: "interaction.requested",
    workId: "work-1",
    sessionId: "session-1",
    payload: {
      interactionId: "interaction-1",
      request: { mode: "cursor_questions", prompt: "First?" },
      requestedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  await events.append({
    category: "interaction.requested",
    workId: "work-2",
    sessionId: "session-1",
    payload: {
      interactionId: "interaction-2",
      request: { mode: "cursor_questions", prompt: "Second?" },
      requestedAt: "2026-01-01T00:00:01.000Z",
    },
  });
  await events.append({
    category: "interaction.completed",
    workId: "work-1",
    sessionId: "session-1",
    payload: {
      interactionId: "interaction-1",
      status: "completed",
      result: { action: "accept", content: { "0": "Yes" } },
      completedAt: "2026-01-01T00:00:02.000Z",
    },
  });

  const pending = await listPendingInteractions<TestRequest>(events, { sessionId: "session-1" });
  assertEquals(pending.length, 1);
  assertEquals(pending[0]?.interactionId, "interaction-2");
  assertEquals(pending[0]?.workId, "work-2");
  assertEquals(pending[0]?.request, { mode: "cursor_questions", prompt: "Second?" });
  assertEquals(await listPendingInteractions(events, { workId: "work-1" }), []);
});
