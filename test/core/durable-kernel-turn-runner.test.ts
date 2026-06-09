import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

import { KvKernelStore } from "../../src/core/mod.ts";
import { TurnRunner } from "../../src/core/turn-runner.ts";
import {
  type ChatMessageData,
  contextEngine,
  FailingSummaryPort,
  FakeModelTurnPort,
  rawMessage,
  RecordingEgressPort,
  recordingObserver,
  RecordingSummaryPort,
  textOf,
  type Tool,
  turnRunOptions,
  withKv,
} from "./durable-kernel-fixtures.ts";

Deno.test("TurnRunner persists turn, model, egress, and completion events around side effects", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    const egress = new RecordingEgressPort();
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model),
      egress,
      tools: () => [] as Tool[],
      baseSystemPrompt: () => "system",
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: {
        input: { text: "hello" },
        egress: { kind: "telegram", chatId: 123 },
      },
    });
    const leased = await queue.leaseNext({ ownerId: "host-a" });
    assert(leased);
    assertEquals(leased.id, work.id);

    await runner.run(leased, turnRunOptions());

    assertEquals(model.requests.length, 1);
    assertEquals(model.requests[0]?.messages.map(textOf), ["hello"]);
    assertEquals(egress.payloads, [{
      workId: work.id,
      sessionId: "session-1",
      target: { kind: "telegram", chatId: 123 },
      replies: ["done"],
    }]);
    assertEquals((await queue.get(work.id))?.status, "completed");
    assertEquals((await events.listBySession(work.sessionId)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "model.message",
      "egress.queued",
      "egress.sent",
      "work.completed",
    ]);
  });
});

Deno.test("TurnRunner records durable tool lifecycle events emitted during model turns", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    model.emitToolEvents = true;
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model),
      egress: new RecordingEgressPort(),
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "use a tool" } },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await runner.run(leased, turnRunOptions());

    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "tool.requested",
      "tool.completed",
      "model.message",
      "egress.queued",
      "egress.sent",
      "work.completed",
    ]);
    const toolEvents = (await events.listByWork(work.id)).filter((event) =>
      event.category === "tool.requested" || event.category === "tool.completed"
    );
    const requested = toolEvents[0]?.payload as { requestedAt?: unknown };
    const completed = toolEvents[1]?.payload as { completedAt?: unknown };
    assert(typeof requested.requestedAt === "string");
    assert(typeof completed.completedAt === "string");
    assertEquals(
      toolEvents.map((event) => {
        const payload = event.payload as Record<string, unknown>;
        const { requestedAt: _requestedAt, completedAt: _completedAt, ...stable } = payload;
        return stable;
      }),
      [
        {
          roundIndex: 0,
          callId: 7,
          toolCallId: "tool-call-7",
          name: "read",
          isQueued: false,
        },
        {
          roundIndex: 0,
          callId: 7,
          toolCallId: "tool-call-7",
          name: "read",
          status: "completed",
        },
      ],
    );
  });
});

Deno.test("TurnRunner finalizes session context before egress and completion", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    const summary = new RecordingSummaryPort();
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model, {
        summary,
        maxContextLength: 2,
        reserveTokens: 1,
      }),
      egress: new RecordingEgressPort(),
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "compact me" } },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await runner.run(leased, turnRunOptions());

    assertEquals(summary.inputs.length, 1);
    assertEquals((await events.listBySession(work.sessionId)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "model.message",
      "session.compacted",
      "egress.queued",
      "egress.sent",
      "work.completed",
    ]);
  });
});

Deno.test("TurnRunner still sends egress and completes work when finalization fails", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    const egress = new RecordingEgressPort();
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model, {
        summary: new FailingSummaryPort(),
        maxContextLength: 2,
        reserveTokens: 1,
      }),
      egress,
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "do not lose the reply" } },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    const result = await runner.run(leased, turnRunOptions());

    assertEquals(result.finalizationError, "finalizer failed");
    assertEquals(egress.payloads.length, 1);
    assertEquals((await queue.get(work.id))?.status, "completed");
    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "model.message",
      "egress.queued",
      "egress.sent",
      "work.completed",
    ]);
  });
});

Deno.test("TurnRunner sends configured fallback egress when the model has no reply text", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    const egress = new RecordingEgressPort();
    model.output = {
      persistedMessages: [],
      replyTexts: [],
    };
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model),
      egress,
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: {
        input: { text: "quiet" },
        telegram: { chatId: 123, replyToMessageId: 7 },
      },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await runner.run(
      leased,
      turnRunOptions({
        target: { chatId: 123, replyToMessageId: 7 },
        fallbackText: "No reply.",
      }),
    );

    assertEquals(egress.payloads, [{
      workId: work.id,
      sessionId: "session-1",
      target: { chatId: 123, replyToMessageId: 7 },
      replies: [],
      fallbackText: "No reply.",
    }]);
    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "egress.queued",
      "egress.sent",
      "work.completed",
    ]);
  });
});

Deno.test("TurnRunner forwards model-act callbacks to an external observer", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    const observed: string[] = [];
    model.emitToolEvents = true;
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model),
      egress: new RecordingEgressPort(),
      tools: () => [],
      baseSystemPrompt: () => "system",
      observer: () => recordingObserver(observed),
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "observe tool" } },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await runner.run(leased, turnRunOptions());

    assertEquals(observed, [
      "tool-start:0:7:tool-call-7",
      "tool-name:7:read",
      "tool-end:0:7:read:false",
      "tool-dequeue:0:7",
      "tool-final:7:read",
    ]);
    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "tool.requested",
      "tool.completed",
      "model.message",
      "egress.queued",
      "egress.sent",
      "work.completed",
    ]);
  });
});

Deno.test("TurnRunner flushes durable tool lifecycle events when a model turn fails", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    model.emitToolEvents = true;
    model.failAfterToolEvents = new Error("model failed after tool");
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model),
      egress: new RecordingEgressPort(),
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "fail after tool" } },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await assertRejects(
      () => runner.run(leased, turnRunOptions()),
      Error,
      "model failed after tool",
    );

    assertEquals((await queue.get(work.id))?.status, "failed");
    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "tool.requested",
      "tool.completed",
      "work.failed",
    ]);
  });
});

Deno.test("TurnRunner records aborted turns as cancelled work", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    model.error = new DOMException("Aborted", "AbortError");
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model),
      egress: new RecordingEgressPort(),
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "cancel me" } },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await assertRejects(
      () => runner.run(leased, turnRunOptions()),
      DOMException,
      "Aborted",
    );

    assertEquals((await queue.get(work.id))?.status, "cancelled");
    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "work.cancelled",
    ]);
  });
});

Deno.test("TurnRunner can release aborted turns back to queued work", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    model.error = new DOMException("Aborted", "AbortError");
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model),
      egress: new RecordingEgressPort(),
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "release me" } },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await assertRejects(
      () => runner.run(leased, turnRunOptions({ abortDisposition: "release" })),
      DOMException,
      "Aborted",
    );

    assertEquals((await queue.get(work.id))?.status, "queued");
    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
      "work.released",
    ]);
  });
});

Deno.test("TurnRunner accepts typed message input and egress targets", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const model = new FakeModelTurnPort();
    const egress = new RecordingEgressPort();
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, model),
      egress,
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const telegramTarget = { chatId: 123, replyToMessageId: 7, threadId: 9 };
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { ignored: true },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await runner.run(
      leased,
      turnRunOptions({
        message: rawMessage("user", "prepared hello"),
        target: telegramTarget,
      }),
    );

    assertEquals(model.requests.length, 1);
    assertEquals(model.requests[0]?.messages.map((message) => [message.role, textOf(message)]), [
      ["user", "prepared hello"],
    ]);
    assertEquals(egress.payloads, [{
      workId: work.id,
      sessionId: "session-1",
      target: telegramTarget,
      replies: ["done"],
    }]);
    const turnInput = (await events.listByWork(work.id)).find((event) => event.category === "turn.input");
    assertEquals(textOf((turnInput?.payload as { message: ChatMessageData }).message), "prepared hello");
  });
});

Deno.test("TurnRunner records image counts for prepared queued message payloads", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
    const queue = events;
    const runner = new TurnRunner({
      events,
      queue,
      context: contextEngine(events, new FakeModelTurnPort()),
      egress: new RecordingEgressPort(),
      tools: () => [],
      baseSystemPrompt: () => "system",
    });
    const imageMessage = {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "file", fileType: "image", identifier: "image-1" },
        { type: "file", fileType: "image", identifier: "image-2" },
      ],
    } as unknown as ChatMessageData;
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { message: imageMessage } },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await runner.run(leased, turnRunOptions({ message: imageMessage }));

    const turnInput = (await events.listByWork(work.id)).find((event) => event.category === "turn.input");
    assertEquals((turnInput?.payload as { input: { text: string; imageCount?: number } }).input, {
      text: "describe this",
      imageCount: 2,
    });
  });
});
