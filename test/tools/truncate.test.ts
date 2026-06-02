import { assertEquals } from "jsr:@std/assert@1";

import { truncateHead, truncateLine, truncateTail } from "../../src/agent/tools/truncate.ts";

Deno.test("truncateHead keeps content within limits", () => {
  const content = "a\nb\nc";
  const result = truncateHead(content, { maxLines: 10, maxBytes: 1024 });
  assertEquals(result.truncated, false);
  assertEquals(result.content, content);
});

Deno.test("truncateHead truncates by line count", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
  const result = truncateHead(lines, { maxLines: 3, maxBytes: 1024 * 1024 });
  assertEquals(result.truncated, true);
  assertEquals(result.truncatedBy, "lines");
  assertEquals(result.outputLines, 3);
});

Deno.test("truncateTail keeps last lines", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
  const result = truncateTail(lines, { maxLines: 2, maxBytes: 1024 * 1024 });
  assertEquals(result.truncated, true);
  assertEquals(result.content, "line8\nline9");
});

Deno.test("truncateLine adds suffix when long", () => {
  const long = "x".repeat(600);
  const { text, wasTruncated } = truncateLine(long, 500);
  assertEquals(wasTruncated, true);
  assertEquals(text.endsWith("[truncated]"), true);
});
