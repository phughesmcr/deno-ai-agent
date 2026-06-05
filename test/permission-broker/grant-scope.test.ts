import { assertEquals } from "jsr:@std/assert@1";

import { currentBrokerGrantScope, withBrokerGrantScope } from "../../src/permission-broker/mod.ts";

Deno.test("broker grant scope defaults to session", () => {
  assertEquals(currentBrokerGrantScope(), "session");
});

Deno.test("withBrokerGrantScope scopes nested broker grant defaults", async () => {
  const seen: string[] = [];

  await withBrokerGrantScope("once", async () => {
    seen.push(currentBrokerGrantScope());
    await withBrokerGrantScope("session", () => {
      seen.push(currentBrokerGrantScope());
    });
    seen.push(currentBrokerGrantScope());
  });
  seen.push(currentBrokerGrantScope());

  assertEquals(seen, ["once", "session", "once", "session"]);
});
