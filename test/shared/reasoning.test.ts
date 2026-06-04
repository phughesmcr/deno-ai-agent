import { assertEquals } from "jsr:@std/assert@1/equals";

import {
  actReasoningParsingOption,
  getActReasoningParsing,
  persistedModelText,
  stripReasoningFromText,
} from "../../src/shared/reasoning.ts";
import { withEnv } from "../_env.ts";

Deno.test("stripReasoningFromText returns visible text after thinking block", () => {
  assertEquals(stripReasoningFromText("thinking</think>Hello!"), "Hello!");
  assertEquals(stripReasoningFromText("<think>hidden</think>World"), "World");
  assertEquals(stripReasoningFromText("<think>no close"), "no close");
});

Deno.test("stripReasoningFromText uses REASONING_START and REASONING_END from env", async () => {
  await withEnv({ REASONING_START: "[[think]]", REASONING_END: "[[/think]]" }, () => {
    assertEquals(stripReasoningFromText("[[think]]hidden[[/think]]Visible"), "Visible");
  });
});

Deno.test("stripReasoningFromText trims when REASONING_ENABLED=false", async () => {
  await withEnv({ REASONING_ENABLED: "false" }, () => {
    assertEquals(
      stripReasoningFromText("<think>secret</think>Hello"),
      "<think>secret</think>Hello",
    );
  });
});

Deno.test("persistedModelText keeps text when KEEP_THINKING=true", async () => {
  await withEnv({ KEEP_THINKING: "true" }, () => {
    assertEquals(
      persistedModelText("<think>x</think>visible"),
      "<think>x</think>visible",
    );
  });
});

Deno.test("persistedModelText strips when KEEP_THINKING=false", async () => {
  await withEnv({ KEEP_THINKING: "false" }, () => {
    assertEquals(persistedModelText("<think>x</think>visible"), "visible");
  });
});

Deno.test("getActReasoningParsing is undefined by default", async () => {
  await withEnv({ REASONING_ACT_PARSING: undefined, REASONING_ENABLED: "true" }, () => {
    assertEquals(getActReasoningParsing(), undefined);
    assertEquals(actReasoningParsingOption(), undefined);
  });
});

Deno.test("getActReasoningParsing returns tags when REASONING_ACT_PARSING=true", async () => {
  await withEnv({ REASONING_ACT_PARSING: "true", REASONING_START: "[[s]]", REASONING_END: "[[e]]" }, () => {
    assertEquals(getActReasoningParsing(), { enabled: true, startString: "[[s]]", endString: "[[e]]" });
    assertEquals(actReasoningParsingOption(), {
      reasoningParsing: { enabled: true, startString: "[[s]]", endString: "[[e]]" },
    });
  });
});

Deno.test("getActReasoningParsing is undefined when REASONING_ENABLED=false", async () => {
  await withEnv({ REASONING_ACT_PARSING: "true", REASONING_ENABLED: "false" }, () => {
    assertEquals(getActReasoningParsing(), undefined);
  });
});

Deno.test("persistedModelText defaults KEEP_THINKING to keep", async () => {
  await withEnv({ KEEP_THINKING: undefined }, () => {
    assertEquals(
      persistedModelText("<think>x</think>visible"),
      "<think>x</think>visible",
    );
  });
});
