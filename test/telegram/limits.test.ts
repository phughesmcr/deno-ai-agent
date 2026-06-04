import { assertEquals } from "jsr:@std/assert@1/equals";

import { splitForTelegram, TELEGRAM_MAX_LENGTH } from "../../src/telegram/limits.ts";

Deno.test("splitForTelegram returns single chunk when under limit", () => {
  assertEquals(splitForTelegram("hello"), ["hello"]);
});

Deno.test("splitForTelegram splits on paragraph boundaries", () => {
  const paragraph = "a".repeat(2000);
  const text = `${paragraph}\n\n${paragraph}`;
  const chunks = splitForTelegram(text, 2500);
  assertEquals(chunks.length, 2);
  assertEquals(chunks.join(""), text);
  for (const chunk of chunks) {
    assertEquals(chunk.length <= 2500, true);
  }
});

Deno.test("splitForTelegram hard-slices when no break fits", () => {
  const text = "x".repeat(TELEGRAM_MAX_LENGTH + 100);
  const chunks = splitForTelegram(text);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0]!.length, TELEGRAM_MAX_LENGTH);
  assertEquals(chunks[1]!.length, 100);
});
