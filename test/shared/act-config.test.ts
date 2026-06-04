import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertThrows } from "jsr:@std/assert@1/throws";

import { getActMaxPredictionRounds } from "../../src/shared/act-config.ts";
import { withEnv } from "../_env.ts";

Deno.test("getActMaxPredictionRounds defaults to 30 for non-Gemma models", async () => {
  await withEnv({ MODEL: "qwen3.6-27b", MAX_PREDICTION_ROUNDS: undefined }, () => {
    assertEquals(getActMaxPredictionRounds(), 30);
  });
});

Deno.test("getActMaxPredictionRounds defaults to 1 for Gemma models", async () => {
  await withEnv({ MODEL: "gemma-4-12b-it", MAX_PREDICTION_ROUNDS: undefined }, () => {
    assertEquals(getActMaxPredictionRounds(), 1);
  });
});

Deno.test("getActMaxPredictionRounds respects MAX_PREDICTION_ROUNDS", async () => {
  await withEnv({ MODEL: "gemma-4-12b-it", MAX_PREDICTION_ROUNDS: "5" }, () => {
    assertEquals(getActMaxPredictionRounds(), 5);
  });
});

Deno.test("getActMaxPredictionRounds rejects invalid env", async () => {
  await withEnv({ MAX_PREDICTION_ROUNDS: "0" }, () => {
    assertThrows(() => getActMaxPredictionRounds(), Error, "positive integer");
  });
});
