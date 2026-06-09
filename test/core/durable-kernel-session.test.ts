import { assertEquals } from "jsr:@std/assert@1";

import { KvKernelStore } from "../../src/core/mod.ts";
import {
  contextEngine,
  FakeModelTurnPort,
  rawMessage,
  RecordingSummaryPort,
  textOf,
  type Tool,
  withKv,
} from "./durable-kernel-fixtures.ts";

Deno.test("SessionContextEngine builds model context from v4 events and compaction checkpoints", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const model = new FakeModelTurnPort();
    const context = contextEngine(events, model);

    await events.append({
      category: "turn.input",
      workId: "work-1",
      sessionId: "session-1",
      payload: { input: { text: "old input" } },
    });
    await events.append({
      category: "model.message",
      workId: "work-1",
      sessionId: "session-1",
      payload: { message: rawMessage("assistant", "old reply") },
    });
    await events.append({
      category: "session.compacted",
      sessionId: "session-1",
      payload: { summary: "old input led to old reply" },
    });
    await events.append({
      category: "turn.input",
      workId: "work-2",
      sessionId: "session-1",
      payload: { input: { text: "new input" } },
    });

    const projection = await context.project({
      sessionId: "session-1",
      baseSystemPrompt: "base prompt",
    });

    assertEquals(projection.systemPrompt, "base prompt\n\nCompacted session context:\nold input led to old reply");
    assertEquals(projection.messages.map((message) => [message.role, textOf(message)]), [["user", "new input"]]);
  });
});

Deno.test("SessionContextEngine persists the core model event sequence", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const model = new FakeModelTurnPort();
    model.emitToolEvents = true;

    const output = await contextEngine(events, model).runModelTurn({
      sessionId: "session-1",
      workId: "work-1",
      inputPayload: {
        input: { text: "hello" },
        message: rawMessage("user", "hello"),
      },
      inputPolicy: "append",
      baseSystemPrompt: "system",
      tools: [{ name: "read" }] as unknown as Tool[],
      signal: new AbortController().signal,
    });

    assertEquals(output.replyTexts, ["done"]);
    assertEquals(model.requests[0]?.messages.map((message) => [message.role, textOf(message)]), [
      ["user", "hello"],
    ]);
    assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
      "turn.input",
      "model.round.started",
      "tool.requested",
      "tool.completed",
      "model.message",
    ]);
  });
});

Deno.test("SessionContextEngine records every model round start emitted by the model adapter", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const model = new FakeModelTurnPort();
    model.roundIndexes = [0, 1];

    await contextEngine(events, model).runModelTurn({
      sessionId: "session-1",
      workId: "work-1",
      inputPayload: { input: { text: "multi-round" } },
      inputPolicy: "append",
      baseSystemPrompt: "system",
      tools: [] as Tool[],
      signal: new AbortController().signal,
    });

    const roundPayloads = (await events.listByWork("work-1"))
      .filter((event) => event.category === "model.round.started")
      .map((event) => event.payload as { roundIndex?: number });
    assertEquals(roundPayloads.map((payload) => payload.roundIndex), [0, 1]);
  });
});

Deno.test("SessionContextEngine compacts sessions from durable projection and reports token totals", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const model = new FakeModelTurnPort();
    const summary = new RecordingSummaryPort();
    const context = contextEngine(events, model, {
      summary,
      maxContextLength: 2,
      reserveTokens: 1,
    });
    await events.append({
      category: "turn.input",
      workId: "work-1",
      sessionId: "session-1",
      payload: { input: { text: "remember this" } },
    });
    await events.append({
      category: "model.message",
      workId: "work-1",
      sessionId: "session-1",
      payload: { message: rawMessage("assistant", "reply") },
    });

    const result = await context.finalizeTurn({
      sessionId: "session-1",
      baseSystemPrompt: "system",
    });

    assertEquals(result, { compacted: true, totalTokens: 1, messageCount: 1 });
    assertEquals(
      summary.inputs.map((input) => ({
        systemPrompt: input.systemPrompt,
        previousSummary: input.previousSummary,
        messages: input.messages.map((message) => [message.role, textOf(message)]),
      })),
      [{
        systemPrompt: "system",
        previousSummary: undefined,
        messages: [
          ["user", "remember this"],
          ["assistant", "reply"],
        ],
      }],
    );
    assertEquals((await events.listBySession("session-1")).map((event) => event.category), [
      "turn.input",
      "model.message",
      "session.compacted",
    ]);
  });
});

Deno.test("SessionContextEngine persists append inputs and avoids duplicate ensure inputs", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const model = new FakeModelTurnPort();
    model.output = { persistedMessages: [], replyTexts: [] };
    const context = contextEngine(events, model);

    await context.runModelTurn({
      sessionId: "session-append",
      workId: "work-append",
      inputPayload: { input: { text: "append" } },
      inputPolicy: "append",
      baseSystemPrompt: "system",
      tools: [] as Tool[],
      signal: new AbortController().signal,
    });
    await context.runModelTurn({
      sessionId: "session-append",
      workId: "work-append",
      inputPayload: { input: { text: "append" } },
      inputPolicy: "append",
      baseSystemPrompt: "system",
      tools: [] as Tool[],
      signal: new AbortController().signal,
    });
    await context.runModelTurn({
      sessionId: "session-ensure",
      workId: "work-ensure",
      inputPayload: { input: { text: "ensure" } },
      inputPolicy: "ensure",
      baseSystemPrompt: "system",
      tools: [] as Tool[],
      signal: new AbortController().signal,
    });
    await context.runModelTurn({
      sessionId: "session-ensure",
      workId: "work-ensure",
      inputPayload: { input: { text: "ensure" } },
      inputPolicy: "ensure",
      baseSystemPrompt: "system",
      tools: [] as Tool[],
      signal: new AbortController().signal,
    });

    assertEquals(
      (await events.listByWork("work-append")).filter((event) => event.category === "turn.input").length,
      2,
    );
    assertEquals(
      (await events.listByWork("work-ensure")).filter((event) => event.category === "turn.input").length,
      1,
    );
  });
});

Deno.test("SessionContextEngine counts the system prompt plus projected messages", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const context = contextEngine(events, new FakeModelTurnPort());
    await events.appendMany([
      {
        category: "turn.input",
        workId: "work-1",
        sessionId: "session-1",
        payload: { input: { text: "hello" } },
      },
      {
        category: "model.message",
        workId: "work-1",
        sessionId: "session-1",
        payload: { message: rawMessage("assistant", "reply") },
      },
    ]);

    const count = await context.countContext({
      sessionId: "session-1",
      baseSystemPrompt: "system",
    });

    assertEquals(count, { tokenCount: 3, messageCount: 3 });
  });
});

Deno.test("SessionContextEngine skips automatic compaction below the reserve threshold", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const model = new FakeModelTurnPort();
    const summary = new RecordingSummaryPort();
    const context = contextEngine(events, model, {
      summary,
      maxContextLength: 10,
      reserveTokens: 1,
    });
    await events.append({
      category: "turn.input",
      workId: "work-1",
      sessionId: "session-1",
      payload: { input: { text: "small" } },
    });

    const result = await context.finalizeTurn({
      sessionId: "session-1",
      baseSystemPrompt: "system",
    });

    assertEquals(result, { compacted: false, totalTokens: 2, messageCount: 2 });
    assertEquals(summary.inputs.length, 0);
    assertEquals((await events.listBySession("session-1")).map((event) => event.category), ["turn.input"]);
  });
});

Deno.test("SessionContextEngine manual compaction records instructions and clears projected messages", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const summary = new RecordingSummaryPort();
    const context = contextEngine(events, new FakeModelTurnPort(), { summary });
    await events.append({
      category: "turn.input",
      workId: "work-1",
      sessionId: "session-1",
      payload: { input: { text: "remember" } },
    });

    const result = await context.compact({
      sessionId: "session-1",
      baseSystemPrompt: "system",
      reason: "manual",
      instructions: "keep the decision",
    });
    const projection = await context.project({
      sessionId: "session-1",
      baseSystemPrompt: "system",
    });

    assertEquals(result.compacted, true);
    assertEquals(summary.inputs[0]?.instructions, "keep the decision");
    assertEquals(projection.compactionSummary, "compact summary");
    assertEquals(projection.messages, []);
    assertEquals((await events.listBySession("session-1")).map((event) => event.category), [
      "turn.input",
      "session.compacted",
    ]);
  });
});

Deno.test("SessionContextEngine no-message compaction returns without appending a checkpoint", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const summary = new RecordingSummaryPort();
    const context = contextEngine(events, new FakeModelTurnPort(), { summary });

    const result = await context.compact({
      sessionId: "session-1",
      baseSystemPrompt: "system",
      reason: "manual",
    });

    assertEquals(result, {
      compacted: false,
      beforeTokens: 1,
      afterTokens: 1,
      reason: "manual",
      messageCount: 1,
    });
    assertEquals(summary.inputs.length, 0);
    assertEquals(await events.listBySession("session-1"), []);
  });
});
