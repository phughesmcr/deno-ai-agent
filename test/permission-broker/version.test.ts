import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import {
  assertPermissionBrokerSupported,
  MIN_BROKER_DENO_VERSION,
  supportsPermissionBroker,
} from "../../src/permission-broker/version.ts";

Deno.test("permission broker runtime gate follows the project Deno 2.8.1 floor", () => {
  assertEquals(MIN_BROKER_DENO_VERSION, { major: 2, minor: 8, patch: 1 });
  assertEquals(supportsPermissionBroker("2.8.0"), false);
  assertEquals(supportsPermissionBroker("2.8.1"), true);
  assertEquals(supportsPermissionBroker("2.9.0"), true);
  assertEquals(supportsPermissionBroker("3.0.0"), true);

  assertThrows(
    () => assertPermissionBrokerSupported("2.8.0"),
    Error,
    "require >= 2.8.1",
  );
});
