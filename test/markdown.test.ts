import { assertEquals } from "jsr:@std/assert@1/equals";
import { escapeMarkdownV2, plainReply, stripThinking } from "../src/telegram/markdown.ts";
import { withEnv } from "./_env.ts";

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
  assertEquals(plainReply("<think>hidden</think>World"), "World");
  assertEquals(plainReply("<think>no close"), "no close");
});

Deno.test("plainReply uses REASONING_START and REASONING_END from env", async () => {
  await withEnv({ REASONING_START: "[[think]]", REASONING_END: "[[/think]]" }, () => {
    assertEquals(plainReply("[[think]]hidden[[/think]]Visible"), "Visible");
  });
});

Deno.test("stripThinking passes through when REASONING_ENABLED=false", async () => {
  const raw = "<think>secret</think>Hello *world*";
  await withEnv({
    REASONING_ENABLED: "false",
    REASONING_START: "<think>",
    REASONING_END: "</think>",
  }, () => {
    assertEquals(stripThinking(raw), escapeMarkdownV2(raw.trim()));
  });
});
