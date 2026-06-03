import { assertEquals } from "jsr:@std/assert@1";

import { ActiveTurnRegistry } from "../../src/telegram/turn-gate.ts";

Deno.test("ActiveTurnRegistry aborts the active turn controllers", () => {
  const registry = new ActiveTurnRegistry();
  const actController = new AbortController();
  const approvalController = new AbortController();

  const clear = registry.setActiveTurn({
    id: "turn-1",
    actController,
    approvalController,
  });

  assertEquals(registry.abortActiveTurn(), true);
  assertEquals(actController.signal.aborted, true);
  assertEquals(approvalController.signal.aborted, true);

  clear();
  assertEquals(registry.abortActiveTurn(), false);
});

Deno.test("ActiveTurnRegistry cleanup does not clear a newer active turn", () => {
  const registry = new ActiveTurnRegistry();
  const first = registry.setActiveTurn({
    id: "turn-1",
    actController: new AbortController(),
    approvalController: new AbortController(),
  });
  const secondAct = new AbortController();
  const secondApproval = new AbortController();

  registry.setActiveTurn({
    id: "turn-2",
    actController: secondAct,
    approvalController: secondApproval,
  });

  first();
  assertEquals(registry.abortActiveTurn(), true);
  assertEquals(secondAct.signal.aborted, true);
  assertEquals(secondApproval.signal.aborted, true);
});
