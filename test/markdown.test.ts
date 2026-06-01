import { assertEquals } from "jsr:@std/assert@1/equals";
import { escapeMarkdownV2, plainReply, stripThinking } from "../src/markdown.ts";

Deno.test("escapeMarkdownV2 escapes special characters", () => {
  assertEquals(
    escapeMarkdownV2("_*[]()~`>#+-=|{}.!\\"),
    "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\",
  );
});

Deno.test("stripThinking returns escaped text when no thinking block", () => {
  assertEquals(stripThinking("hello.world *bold*"), "hello\\.world \\*bold\\*");
});

Deno.test("stripThinking formats thinking and response", () => {
  assertEquals(
    stripThinking("<think>Let me think\nnext</think>The answer is 42."),
    "**>Let me think\n>next||\n\nThe answer is 42\\.",
  );
});

Deno.test("plainReply returns visible text after thinking block", () => {
  assertEquals(plainReply("thinking</think>Hello!"), "Hello!");
  assertEquals(plainReply("<redacted_thinking>hidden</redacted_thinking>World"), "World");
  assertEquals(plainReply("<think>no close"), "no close");
});
