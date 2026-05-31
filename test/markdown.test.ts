import { assertEquals } from "jsr:@std/assert@1/equals";
import { escapeMarkdownV2, stripThinking } from "../src/markdown.ts";

Deno.test("escapeMarkdownV2 escapes special characters", () => {
  assertEquals(escapeMarkdownV2("hello.world"), "hello\\.world");
});

Deno.test("stripThinking returns escaped text when no thinking block", () => {
  assertEquals(stripThinking("hello"), "hello");
});

Deno.test("stripThinking formats thinking and response", () => {
  const result = stripThinking("Let me think" + "</think>" + "The answer is 42");
  assertEquals(result.endsWith("The answer is 42"), true);
});
