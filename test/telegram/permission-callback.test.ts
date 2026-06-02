import { assertEquals } from "jsr:@std/assert@1";
import {
  assertPermissionCallbackFits,
  encodePermissionCallback,
  parsePermissionCallback,
  toShortRequestId,
} from "../../src/telegram/permission-callback.ts";

Deno.test("permission callback encoding fits telegram limit", () => {
  const shortId = toShortRequestId("550e8400-e29b-41d4-a716-446655440000");
  for (const action of ["once", "session", "deny"] as const) {
    const data = encodePermissionCallback(shortId, action);
    assertPermissionCallbackFits(data);
    assertEquals(parsePermissionCallback(data)?.action, action);
  }
});
