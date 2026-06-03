import { assertEquals } from "jsr:@std/assert@1/equals";
import { escapeMarkdownV2, plainReply, stripThinking } from "../src/telegram/markdown.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = Object.fromEntries(
    Object.keys(vars).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

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
    stripThinking("<redacted_thinking>Let me think\nnext</redacted_thinking>The answer is 42."),
    "**>Let me think\n>next||\n\nThe answer is 42\\.",
  );
});

Deno.test("plainReply returns visible text after thinking block", () => {
  assertEquals(plainReply("thinking</redacted_thinking>Hello!"), "Hello!");
  assertEquals(plainReply("<redacted_thinking>hidden</redacted_thinking>World"), "World");
  assertEquals(plainReply("<redacted_thinking>no close"), "no close");
});

Deno.test("plainReply uses REASONING_START and REASONING_END from env", () => {
  withEnv({ REASONING_START: "[[think]]", REASONING_END: "[[/think]]" }, () => {
    assertEquals(plainReply("[[think]]hidden[[/think]]Visible"), "Visible");
  });
});

Deno.test("stripThinking passes through when REASONING_ENABLED=false", () => {
  withEnv({ REASONING_ENABLED: "false" }, () => {
    assertEquals(
      stripThinking("<redacted_thinking>secret</redacted_thinking>Hello *world*"),
      "<redacted\\_thinking\\>secret</redacted\\_thinking\\>Hello \\*world\\*",
    );
  });
});
