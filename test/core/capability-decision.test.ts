import { assertEquals } from "jsr:@std/assert@1";

import {
  CapabilityDecisionService,
  CapabilityLedger,
  type CapabilityPromptDecision,
  type CapabilityRequest,
  KvKernelStore,
  listPendingCapabilities,
} from "../../src/core/mod.ts";
import { MemoryKernelStore } from "../support/memory-kernel-store.ts";

const BASE_REQUEST: CapabilityRequest = {
  id: "capability-1",
  sessionId: "session-1",
  workId: "work-1",
  source: "local_tool",
  capability: { kind: "local_tool", target: "MEMORY.md", action: "write" },
  risk: "medium",
  summary: "write 5 bytes",
  timeoutMs: 1_000,
  display: {
    action: "write",
    target: "MEMORY.md",
  },
};

function promptDecision(
  decision: CapabilityPromptDecision["decision"],
  scope: CapabilityPromptDecision["scope"],
  reason = decision === "allow" ? "approved" : "denied",
): CapabilityPromptDecision {
  return {
    decision,
    scope,
    reason,
    decidedAt: "2026-01-02T03:04:05.000Z",
    decidedBy: "admin",
  };
}

async function withLedger(
  fn: (ledger: CapabilityLedger, events: KvKernelStore, service: CapabilityDecisionService) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    const events = new KvKernelStore(kv);
    const ledger = new CapabilityLedger({ kv, events });
    const service = new CapabilityDecisionService({ ledger, events });
    await fn(ledger, events, service);
  } finally {
    kv.close();
  }
}

Deno.test("CapabilityDecisionService records prompted once approvals as consumed decisions", async () => {
  await withLedger(async (ledger, events, service) => {
    const result = await service.decide(BASE_REQUEST, {
      decide: () => Promise.resolve(promptDecision("allow", "once")),
    });

    assertEquals(result, {
      allowed: true,
      reason: "approved",
      scope: "once",
      source: "prompt",
      grant: "once",
    });
    assertEquals((await events.listBySession("session-1")).map((event) => event.category), [
      "approval.requested",
      "approval.decided",
    ]);
    assertEquals(
      (await ledger.authorize({
        sessionId: BASE_REQUEST.sessionId,
        capability: BASE_REQUEST.capability,
      })).state,
      "unresolved",
    );
  });
});

Deno.test("CapabilityDecisionService records prompted session approvals as reusable grants", async () => {
  await withLedger(async (ledger, events, service) => {
    const result = await service.decide(BASE_REQUEST, {
      decide: () => Promise.resolve(promptDecision("allow", "session")),
    });

    assertEquals(result.allowed, true);
    assertEquals(result.scope, "session");
    assertEquals(result.grant, "session");
    assertEquals(
      (await ledger.authorize({
        sessionId: BASE_REQUEST.sessionId,
        capability: BASE_REQUEST.capability,
      })).state,
      "allowed",
    );
    assertEquals((await events.listByWork("work-1")).map((event) => event.category), [
      "approval.requested",
      "approval.decided",
    ]);
  });
});

Deno.test("CapabilityDecisionService emits ledger decisions without prompting active session grants", async () => {
  await withLedger(async (ledger, events, service) => {
    await ledger.recordDecision({
      sessionId: BASE_REQUEST.sessionId,
      capability: BASE_REQUEST.capability,
      decision: "allow",
      scope: "session",
      reason: "preapproved",
    });
    const before = (await events.list()).at(-1)?.sequence ?? 0;
    let prompted = false;

    const result = await service.decide(BASE_REQUEST, {
      decide: () => {
        prompted = true;
        return Promise.resolve(promptDecision("deny", "once", "should_not_prompt"));
      },
    });

    assertEquals(prompted, false);
    assertEquals(result, {
      allowed: true,
      reason: "preapproved",
      scope: "session",
      source: "ledger",
      grant: "session",
    });
    assertEquals((await events.list({ afterSequence: before })).map((event) => event.category), [
      "approval.requested",
      "approval.decided",
    ]);
    assertEquals((await events.list({ afterSequence: before }))[1]?.payload, {
      capability: BASE_REQUEST.capability,
      decision: "allow",
      scope: "session",
      reason: "preapproved",
      source: "ledger",
    });
  });
});

Deno.test("CapabilityDecisionService denies active ledger denials without prompting", async () => {
  await withLedger(async (ledger, _events, service) => {
    await ledger.recordDecision({
      sessionId: BASE_REQUEST.sessionId,
      capability: BASE_REQUEST.capability,
      decision: "deny",
      scope: "session",
      reason: "blocked",
    });
    let prompted = false;

    const result = await service.decide(BASE_REQUEST, {
      decide: () => {
        prompted = true;
        return Promise.resolve(promptDecision("allow", "once"));
      },
    });

    assertEquals(prompted, false);
    assertEquals(result.allowed, false);
    assertEquals(result.reason, "blocked");
    assertEquals(result.source, "ledger");
  });
});

Deno.test("CapabilityDecisionService consumes active once grants exactly once", async () => {
  await withLedger(async (ledger, _events, service) => {
    await ledger.recordDecision({
      sessionId: BASE_REQUEST.sessionId,
      capability: BASE_REQUEST.capability,
      decision: "allow",
      scope: "once",
      reason: "one-shot",
    });
    let prompted = 0;

    const first = await service.decide(BASE_REQUEST, {
      decide: () => {
        prompted++;
        return Promise.resolve(promptDecision("deny", "once", "unexpected"));
      },
    });
    const second = await service.decide({ ...BASE_REQUEST, id: "capability-2" }, {
      decide: () => {
        prompted++;
        return Promise.resolve(promptDecision("deny", "once", "spent"));
      },
    });

    assertEquals(first.allowed, true);
    assertEquals(first.source, "ledger");
    assertEquals(second.allowed, false);
    assertEquals(second.source, "prompt");
    assertEquals(prompted, 1);
  });
});

Deno.test("listPendingCapabilities replays unresolved capability requests", async () => {
  const events = new MemoryKernelStore();
  await events.append({
    category: "approval.requested",
    workId: "work-1",
    sessionId: "session-1",
    payload: { capability: BASE_REQUEST.capability, request: BASE_REQUEST },
  });
  await events.append({
    category: "approval.requested",
    workId: "work-2",
    sessionId: "session-1",
    payload: {
      capability: BASE_REQUEST.capability,
      request: { ...BASE_REQUEST, id: "capability-2", workId: "work-2" },
    },
  });
  await events.append({
    category: "approval.decided",
    workId: "work-1",
    sessionId: "session-1",
    payload: {
      capability: BASE_REQUEST.capability,
      decision: "allow",
      scope: "once",
      reason: "approved",
    },
  });

  const pending = await listPendingCapabilities(events, { sessionId: "session-1" });

  assertEquals(pending.length, 1);
  assertEquals(pending[0]?.workId, "work-2");
  assertEquals(pending[0]?.sessionId, "session-1");
  assertEquals(pending[0]?.capability, BASE_REQUEST.capability);
  assertEquals(await listPendingCapabilities(events, { workId: "work-1" }), []);
});
