import { assertEquals } from "jsr:@std/assert@1";
import {
  assertCapabilityCallbackFits,
  encodeCapabilityCallback,
  parseCapabilityCallback,
  toShortCapabilityRequestId,
} from "../../src/telegram/capability-callback.ts";

Deno.test("capability callback encoding fits telegram limit", () => {
  const shortId = toShortCapabilityRequestId("550e8400-e29b-41d4-a716-446655440000");
  for (const action of ["approve", "once", "session", "deny"] as const) {
    const data = encodeCapabilityCallback(shortId, action);
    assertCapabilityCallbackFits(data);
    assertEquals(parseCapabilityCallback(data)?.action, action);
  }
});
