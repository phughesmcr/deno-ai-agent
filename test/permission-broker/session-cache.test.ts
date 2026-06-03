import { assertEquals } from "jsr:@std/assert@1";
import { SessionCache } from "../../src/permission-broker/session-cache.ts";

Deno.test("SessionCache consumes once grant exactly once", () => {
  const cache = new SessionCache();
  cache.grant("run", "/bin/sh", "once");
  assertEquals(cache.consume("run", "/bin/sh"), true);
  assertEquals(cache.consume("run", "/bin/sh"), false);
});

Deno.test("SessionCache session grant allows repeated matches", () => {
  const cache = new SessionCache();
  cache.grant("run", "/bin/sh", "session");
  assertEquals(cache.consume("run", "/bin/sh"), true);
  assertEquals(cache.consume("run", "/bin/sh"), true);
});
