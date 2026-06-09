import { assertEquals } from "jsr:@std/assert@1";

import { isAbortError } from "../../src/shared/abort.ts";

Deno.test("isAbortError matches DOMException AbortError", () => {
  assertEquals(isAbortError(new DOMException("stopped", "AbortError")), true);
});

Deno.test("isAbortError matches Error name and aborted message", () => {
  assertEquals(isAbortError(new Error("aborted")), true);
  assertEquals(isAbortError(Object.assign(new Error("x"), { name: "AbortError" })), true);
});

Deno.test("isAbortError matches signal reason when signal is aborted", () => {
  const controller = new AbortController();
  const reason = new Error("turn cancelled");
  controller.abort(reason);
  assertEquals(isAbortError(reason, controller.signal), true);
});

Deno.test("isAbortError rejects unrelated errors", () => {
  assertEquals(isAbortError(new Error("network failure")), false);
  assertEquals(isAbortError("aborted"), false);
});
