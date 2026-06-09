import { assertEquals } from "jsr:@std/assert@1";

import {
  composeToolLifecycleObservers,
  createDurableToolEventObserver,
  type ToolLifecycleObserver,
} from "../../src/core/mod.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

Deno.test("durable tool observer records requested and completed events", async () => {
  const events = new MemoryKernelStore();
  const observer = createDurableToolEventObserver({
    events,
    sessionId: "session-1",
    workId: "work-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  observer.onToolCallRequestStart(0, 7, "tool-call-1");
  observer.onToolCallRequestNameReceived(7, "read");
  observer.onToolCallRequestEnd(0, 7, "read", true);
  observer.onToolCallRequestDequeued(0, 7);
  observer.onToolCallRequestFinalized(7, "read");
  await observer.flush();

  const durableEvents = await events.listByWork("work-1");
  assertEquals(durableEvents.map((event) => event.category), ["tool.requested", "tool.completed"]);
  assertEquals(durableEvents.map((event) => event.payload), [
    {
      roundIndex: 0,
      callId: 7,
      toolCallId: "tool-call-1",
      name: "read",
      isQueued: true,
      requestedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      roundIndex: 0,
      callId: 7,
      toolCallId: "tool-call-1",
      name: "read",
      status: "completed",
      completedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

Deno.test("durable tool observer records failed tool calls", async () => {
  const events = new MemoryKernelStore();
  const observer = createDurableToolEventObserver({
    events,
    sessionId: "session-1",
    workId: "work-1",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  observer.onToolCallRequestStart(1, 9, "tool-call-2");
  observer.onToolCallRequestNameReceived(9, "bash");
  observer.onToolCallRequestFailure(9, "tool failed");
  await observer.flush();

  assertEquals((await events.listByWork("work-1")).map((event) => event.payload), [
    {
      roundIndex: 1,
      callId: 9,
      toolCallId: "tool-call-2",
      name: "bash",
      status: "failed",
      error: "tool failed",
      completedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

Deno.test("durable tool observer records one model round start per round index", async () => {
  const events = new MemoryKernelStore();
  const observer = createDurableToolEventObserver({
    events,
    sessionId: "session-1",
    workId: "work-1",
    projectedThroughSequence: 12,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  observer.ensureRoundStarted(0);
  observer.onRoundStart(0);
  observer.onRoundStart(1);
  observer.onRoundStart(1);
  await observer.flush();

  assertEquals((await events.listByWork("work-1")).map((event) => event.payload), [
    {
      roundIndex: 0,
      projectedThroughSequence: 12,
      startedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      roundIndex: 1,
      projectedThroughSequence: 12,
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
});

Deno.test("composeToolLifecycleObservers forwards callbacks to all observers", () => {
  const events: string[] = [];
  function observer(label: string): ToolLifecycleObserver {
    return {
      onMessage: () => events.push(`${label}:message`),
      onFirstToken: (roundIndex) => events.push(`${label}:first:${roundIndex}`),
      onRoundStart: (roundIndex) => events.push(`${label}:round-start:${roundIndex}`),
      onRoundEnd: (roundIndex) => events.push(`${label}:round-end:${roundIndex}`),
      onToolCallRequestStart: (_roundIndex, callId) => events.push(`${label}:tool-start:${callId}`),
      onToolCallRequestNameReceived: (callId, name) => events.push(`${label}:tool-name:${callId}:${name}`),
      onToolCallRequestEnd: (_roundIndex, callId, name) => events.push(`${label}:tool-end:${callId}:${name}`),
      onToolCallRequestFailure: (callId, message) => events.push(`${label}:tool-fail:${callId}:${message}`),
      onToolCallRequestFinalized: (callId, name) => events.push(`${label}:tool-done:${callId}:${name}`),
      onToolCallRequestDequeued: (_roundIndex, callId) => events.push(`${label}:tool-dequeue:${callId}`),
    };
  }

  const composed = composeToolLifecycleObservers([observer("a"), undefined, observer("b")]);
  composed.onToolCallRequestNameReceived(4, "read");
  composed.onToolCallRequestFinalized(4, "read");

  assertEquals(events, [
    "a:tool-name:4:read",
    "b:tool-name:4:read",
    "a:tool-done:4:read",
    "b:tool-done:4:read",
  ]);
});
