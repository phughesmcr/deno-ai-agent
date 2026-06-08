import { ChatMessage, type ChatMessageData, type Tool } from "@lmstudio/sdk";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  CapabilityLedger,
  type ContextSummaryPort,
  type EgressPort,
  KvEventStore,
  KvWorkQueue,
  type ModelTurnOutput,
  type ModelTurnPort,
  type ModelTurnRequest,
  SessionContextEngine,
  type SummaryCompactionInput,
  TurnRunner,
  WorkspaceGate,
} from "../../src/core/mod.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

class FakeModelTurnPort implements ModelTurnPort {
  readonly requests: ModelTurnRequest[] = [];
  output: ModelTurnOutput = {
    persistedMessages: [rawMessage("assistant", "done")],
    replyTexts: ["done"],
  };
  emitToolEvents = false;
  roundIndexes: number[] = [];
  failAfterToolEvents: Error | undefined;
  error: Error | undefined;

  run(request: ModelTurnRequest): Promise<ModelTurnOutput> {
    this.requests.push(request);
    for (const roundIndex of this.roundIndexes) {
      request.observer?.onRoundStart(roundIndex);
      request.observer?.onRoundEnd(roundIndex);
    }
    if (this.emitToolEvents) {
      request.observer?.onToolCallRequestStart(0, 7, "tool-call-7");
      request.observer?.onToolCallRequestNameReceived(7, "read");
      request.observer?.onToolCallRequestEnd(0, 7, "read", false);
      request.observer?.onToolCallRequestDequeued(0, 7);
      request.observer?.onToolCallRequestFinalized(7, "read");
    }
    if (this.failAfterToolEvents) return Promise.reject(this.failAfterToolEvents);
    if (this.error) return Promise.reject(this.error);
    return Promise.resolve(this.output);
  }

  countTokens(messages: ChatMessageData[]): Promise<number[]> {
    return Promise.resolve(messages.map(() => 1));
  }
}

class RecordingEgressPort implements EgressPort {
  readonly payloads: unknown[] = [];

  send(payload: unknown): Promise<void> {
    this.payloads.push(payload);
    return Promise.resolve();
  }
}

class RecordingSummaryPort implements ContextSummaryPort {
  readonly inputs: SummaryCompactionInput[] = [];
  summary = "compact summary";

  summarize(input: SummaryCompactionInput): Promise<string> {
    this.inputs.push(input);
    return Promise.resolve(this.summary);
  }
}

class FailingSummaryPort implements ContextSummaryPort {
  summarize(): Promise<never> {
    return Promise.reject(new Error("finalizer failed"));
  }
}

function recordingObserver(events: string[]): NonNullable<ModelTurnRequest["observer"]> {
  return {
    onMessage(): void {
      events.push("message");
    },
    onFirstToken(roundIndex: number, ms?: number): void {
      events.push(`first:${roundIndex}:${ms ?? ""}`);
    },
    onRoundStart(roundIndex: number): void {
      events.push(`round-start:${roundIndex}`);
    },
    onRoundEnd(roundIndex: number): void {
      events.push(`round-end:${roundIndex}`);
    },
    onToolCallRequestStart(roundIndex: number, callId: number, toolCallId?: string): void {
      events.push(`tool-start:${roundIndex}:${callId}:${toolCallId ?? ""}`);
    },
    onToolCallRequestNameReceived(callId: number, name: string): void {
      events.push(`tool-name:${callId}:${name}`);
    },
    onToolCallRequestEnd(roundIndex: number, callId: number, name: string, isQueued: boolean): void {
      events.push(`tool-end:${roundIndex}:${callId}:${name}:${isQueued}`);
    },
    onToolCallRequestFailure(callId: number, message: string): void {
      events.push(`tool-fail:${callId}:${message}`);
    },
    onToolCallRequestFinalized(callId: number, name: string): void {
      events.push(`tool-final:${callId}:${name}`);
    },
    onToolCallRequestDequeued(roundIndex: number, callId: number): void {
      events.push(`tool-dequeue:${roundIndex}:${callId}`);
    },
  };
}

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

function textOf(message: { content: readonly unknown[] }): string {
  return message.content.flatMap((part) => {
    if (part === null || typeof part !== "object") return [];
    if (!("type" in part) || part.type !== "text" || !("text" in part) || typeof part.text !== "string") return [];
    return [part.text];
  }).join("");
}

async function withKv(fn: (kv: Deno.Kv) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(kv);
  } finally {
    kv.close();
  }
}

function contextEngine(
  events: KvEventStore,
  model: ModelTurnPort,
  options?: { summary?: ContextSummaryPort; maxContextLength?: number; reserveTokens?: number },
): SessionContextEngine {
  return new SessionContextEngine({
    events,
    model,
    summary: options?.summary ?? new RecordingSummaryPort(),
    maxContextLength: options?.maxContextLength ?? 100,
    ...(options?.reserveTokens !== undefined ? { reserveTokens: options.reserveTokens } : {}),
  });
}

Deno.test("KvEventStore appends ordered events and replays by work and session", async () => {
  await withKv(async (kv) => {
    const events = new KvEventStore(kv);

    const first = await events.append({
      category: "work.created",
      workId: "work-1",
      sessionId: "session-1",
      payload: { kind: "user_turn" },
    });
    const second = await events.append({
      category: "turn.input",
      workId: "work-1",
      sessionId: "session-1",
      payload: { text: "hello" },
    });

    assertEquals(first.sequence, 1);
    assertEquals(second.sequence, 2);
    assertEquals((await events.list()).map((event) => event.category), ["work.created", "turn.input"]);
    assertEquals((await events.listByWork("work-1")).map((event) => event.sequence), [1, 2]);
    assertEquals((await events.listBySession("session-1")).map((event) => event.sequence), [1, 2]);
  });
});

Deno.test("KvWorkQueue leases, completes, and recovers interrupted work durably", async () => {
  await withKv(async (kv) => {
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
    const work = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "hello" } },
      availableAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const leased = await queue.leaseNext({
      ownerId: "host-a",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    assert(leased);
    assertEquals(leased.id, work.id);
    assertEquals(leased.status, "leased");
    assertEquals(leased.attempts, 1);
    assertEquals(
      await queue.leaseNext({
        ownerId: "host-b",
        now: new Date("2026-01-01T00:00:00.100Z"),
      }),
      null,
    );

    const recovered = await queue.recoverInterruptedWork({
      now: new Date("2026-01-01T00:00:00.100Z"),
      maxAttempts: 3,
    });
    assertEquals(recovered.requeued, [work.id]);
    assertEquals(recovered.failed, []);

    const leasedAgain = await queue.leaseNext({
      ownerId: "host-b",
      now: new Date("2026-01-01T00:00:02.000Z"),
    });
    assert(leasedAgain);
    assertEquals(leasedAgain.attempts, 2);

    await queue.complete(leasedAgain.id, {
      leaseId: leasedAgain.lease.id,
      now: new Date("2026-01-01T00:00:02.100Z"),
    });

    assertEquals((await queue.get(leasedAgain.id))?.status, "completed");
    assertEquals((await events.listBySession(work.sessionId)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "work.leased",
      "work.completed",
    ]);
  });
});

Deno.test("KvWorkQueue leases a specific submitted work item", async () => {
  await withKv(async (kv) => {
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
    const first = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "first" } },
    });
    const second = await queue.submit({
      kind: "user_turn",
      sessionId: "session-1",
      payload: { input: { text: "second" } },
    });

    const leasedSecond = await queue.lease(second.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });

    assert(leasedSecond);
    assertEquals(leasedSecond.id, second.id);
    assertEquals((await queue.get(first.id))?.status, "queued");
    assertEquals((await queue.get(second.id))?.status, "leased");
  });
});

Deno.test("WorkspaceGate serializes in-process workspace turns", async () => {
  const gate = new WorkspaceGate();
  const order: string[] = [];
  const releaseFirst = Promise.withResolvers<void>();
  const firstEntered = Promise.withResolvers<void>();

  const first = gate.runExclusive("first", new AbortController().signal, async () => {
    order.push("first:start");
    firstEntered.resolve();
    await releaseFirst.promise;
    order.push("first:end");
  });
  await firstEntered.promise;

  const second = gate.runExclusive("second", new AbortController().signal, () => {
    order.push("second");
    return Promise.resolve();
  });
  await Promise.resolve();
  assertEquals(order, ["first:start"]);

  releaseFirst.resolve();
  await first;
  await second;
  assertEquals(order, ["first:start", "first:end", "second"]);
});

Deno.test("CapabilityLedger persists allow, deny, and once decisions", async () => {
  await withKv(async (kv) => {
    const events = new KvEventStore(kv);
    const ledger = new CapabilityLedger({ kv, events });
    await ledger.recordDecision({
      sessionId: "session-1",
      capability: { kind: "local_tool", target: "read", action: "execute" },
      decision: "allow",
      scope: "once",
      reason: "user approved",
    });
    await ledger.recordDecision({
      sessionId: "session-1",
      capability: { kind: "mcp_tool", target: "github/create_issue", action: "execute" },
      decision: "deny",
      scope: "session",
      reason: "not now",
    });

    assertEquals(
      (await ledger.authorize({
        sessionId: "session-1",
        capability: { kind: "local_tool", target: "read", action: "execute" },
      })).state,
      "allowed",
    );
    assertEquals(
      (await ledger.authorize({
        sessionId: "session-1",
        capability: { kind: "local_tool", target: "read", action: "execute" },
      })).state,
      "unresolved",
    );
    assertEquals(
      (await ledger.authorize({
        sessionId: "session-1",
        capability: { kind: "mcp_tool", target: "github/create_issue", action: "execute" },
      })).state,
      "denied",
    );
    assertEquals((await events.listBySession("session-1")).map((event) => event.category), [
      "approval.decided",
      "approval.decided",
    ]);
  });
});

Deno.test("SessionContextEngine builds model context from v4 events and compaction checkpoints", async () => {
  await withKv(async (kv) => {
    const events = new KvEventStore(kv);
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
    const events = new KvEventStore(kv);
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
    const events = new KvEventStore(kv);
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
    const events = new KvEventStore(kv);
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
        details: input.details,
      })),
      [{
        systemPrompt: "system",
        previousSummary: undefined,
        messages: [
          ["user", "remember this"],
          ["assistant", "reply"],
        ],
        details: { readFiles: [], modifiedFiles: [] },
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
    const events = new KvEventStore(kv);
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
    const events = new KvEventStore(kv);
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
    const events = new KvEventStore(kv);
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
    const events = new KvEventStore(kv);
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
    const events = new KvEventStore(kv);
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

Deno.test("TurnRunner persists turn, model, egress, and completion events around side effects", async () => {
  await withKv(async (kv) => {
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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

    await runner.run(leased, { signal: new AbortController().signal });

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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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

    await runner.run(leased, { signal: new AbortController().signal });

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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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

    await runner.run(leased, { signal: new AbortController().signal });

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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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

    const result = await runner.run(leased, { signal: new AbortController().signal });

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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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
      fallbackText: () => "No reply.",
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

    await runner.run(leased, { signal: new AbortController().signal });

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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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

    await runner.run(leased, { signal: new AbortController().signal });

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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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
      () => runner.run(leased, { signal: new AbortController().signal }),
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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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
      () => runner.run(leased, { signal: new AbortController().signal }),
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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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
      () => runner.run(leased, { signal: new AbortController().signal, abortDisposition: "release" }),
      DOMException,
      "Aborted",
    );

    assertEquals((await queue.get(work.id))?.status, "queued");
    assertEquals((await events.listByWork(work.id)).map((event) => event.category), [
      "work.created",
      "work.leased",
      "turn.input",
      "model.round.started",
    ]);
  });
});

Deno.test("TurnRunner accepts prepared queued message payloads and Telegram egress targets", async () => {
  await withKv(async (kv) => {
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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
      payload: {
        input: { message: rawMessage("user", "prepared hello") },
        telegram: telegramTarget,
      },
    });
    const leased = await queue.lease(work.id, {
      ownerId: "host-a",
      kinds: ["user_turn"],
    });
    assert(leased);

    await runner.run(leased, { signal: new AbortController().signal });

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
    const events = new KvEventStore(kv);
    const queue = new KvWorkQueue({ kv, events });
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

    await runner.run(leased, { signal: new AbortController().signal });

    const turnInput = (await events.listByWork(work.id)).find((event) => event.category === "turn.input");
    assertEquals((turnInput?.payload as { input: { text: string; imageCount?: number } }).input, {
      text: "describe this",
      imageCount: 2,
    });
  });
});
