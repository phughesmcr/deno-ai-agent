import { assertEquals } from "jsr:@std/assert@1";

import {
  assertCallbackFits,
  encodeCancelCallback,
  encodeDoneCallback,
  encodeOptionCallback,
  encodeOtherCallback,
  encodeToggleCallback,
  isSessionCallback,
  parseOptionIndex,
} from "../../src/telegram/user-question-callback.ts";

Deno.test("callback_data stays within 64 bytes at high sessionId", () => {
  const sessionId = 999_999_999;
  const samples = [
    encodeOptionCallback(sessionId, 3),
    encodeOtherCallback(sessionId),
    encodeCancelCallback(sessionId),
    encodeToggleCallback(sessionId, 2),
    encodeDoneCallback(sessionId),
  ];
  for (const data of samples) {
    assertCallbackFits(data);
    assertEquals(new TextEncoder().encode(data).length <= 64, true);
  }
});

Deno.test("isSessionCallback and parseOptionIndex", () => {
  const data = encodeOptionCallback(7, 2);
  assertEquals(isSessionCallback(data, 7), true);
  assertEquals(isSessionCallback(data, 8), false);
  assertEquals(parseOptionIndex(data), 2);
});

Deno.test("option and other callbacks share session prefix", () => {
  assertEquals(isSessionCallback(encodeOtherCallback(42), 42), true);
  assertEquals(isSessionCallback(encodeCancelCallback(42), 42), true);
});
