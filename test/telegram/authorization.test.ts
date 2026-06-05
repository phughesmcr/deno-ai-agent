import { assertEquals } from "jsr:@std/assert@1";

import { shouldIgnoreUnauthorizedMessage } from "../../src/telegram/authorization.ts";

Deno.test("shouldIgnoreUnauthorizedMessage ignores bot-originated messages", () => {
  assertEquals(
    shouldIgnoreUnauthorizedMessage(
      { from: { id: 42, is_bot: true } },
    ),
    true,
  );
});

Deno.test("shouldIgnoreUnauthorizedMessage ignores sender-less service messages", () => {
  assertEquals(
    shouldIgnoreUnauthorizedMessage(
      {},
    ),
    true,
  );
});

Deno.test("shouldIgnoreUnauthorizedMessage does not ignore real users", () => {
  assertEquals(
    shouldIgnoreUnauthorizedMessage({ from: { id: 7, is_bot: false } }),
    false,
  );
});
