import { z } from "zod/v3";

const DEFAULT_MAX_PREDICTION_ROUNDS = 30;
const GEMMA_MAX_PREDICTION_ROUNDS = 1;

const maxPredictionRoundsSchema = z.string().optional().transform((value) => {
  if (value === undefined || value === "") return undefined;
  const rounds = Number(value);
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error("MAX_PREDICTION_ROUNDS must be a positive integer");
  }
  return rounds;
});

function defaultMaxPredictionRounds(model: string | undefined): number {
  if (model?.toLowerCase().includes("gemma")) return GEMMA_MAX_PREDICTION_ROUNDS;
  return DEFAULT_MAX_PREDICTION_ROUNDS;
}

/** `model.act()` `maxPredictionRounds` from `MAX_PREDICTION_ROUNDS` or model-specific default. */
export function getActMaxPredictionRounds(): number {
  const rounds = maxPredictionRoundsSchema.parse(Deno.env.get("MAX_PREDICTION_ROUNDS"));
  return rounds ?? defaultMaxPredictionRounds(Deno.env.get("MODEL"));
}
