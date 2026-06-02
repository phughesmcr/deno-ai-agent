import { assertEquals } from "jsr:@std/assert@1/equals";
import { tokenBucket } from "../src/shared/otel.ts";

Deno.test("tokenBucket labels token count boundaries", () => {
  assertEquals(tokenBucket(999), "lt_1k");
  assertEquals(tokenBucket(1_000), "1k_2k");
  assertEquals(tokenBucket(1_999), "1k_2k");
  assertEquals(tokenBucket(2_000), "2k_4k");
  assertEquals(tokenBucket(3_999), "2k_4k");
  assertEquals(tokenBucket(4_000), "4k_8k");
  assertEquals(tokenBucket(7_999), "4k_8k");
  assertEquals(tokenBucket(8_000), "8k_16k");
  assertEquals(tokenBucket(15_999), "8k_16k");
  assertEquals(tokenBucket(16_000), "16k_32k");
  assertEquals(tokenBucket(31_999), "16k_32k");
  assertEquals(tokenBucket(32_000), "32k_64k");
  assertEquals(tokenBucket(63_999), "32k_64k");
  assertEquals(tokenBucket(64_000), "64k_128k");
  assertEquals(tokenBucket(127_999), "64k_128k");
  assertEquals(tokenBucket(128_000), "gte_128k");
});
