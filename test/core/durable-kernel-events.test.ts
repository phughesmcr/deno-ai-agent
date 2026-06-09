import { assertEquals } from "jsr:@std/assert@1";

import { CapabilityLedger, KvKernelStore } from "../../src/core/mod.ts";
import { withKv } from "./durable-kernel-fixtures.ts";

Deno.test("KvKernelStore appends ordered events and replays by work and session", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);

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

Deno.test("CapabilityLedger persists allow, deny, and once decisions", async () => {
  await withKv(async (kv) => {
    const events = new KvKernelStore(kv);
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
