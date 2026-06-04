const DEFAULT_MAX_PREDICTION_ROUNDS = 30;

/** `model.act()` `maxPredictionRounds` from `MAX_PREDICTION_ROUNDS` or model-specific default. */
export function getActMaxPredictionRounds(): number {
  const raw = Deno.env.get("MAX_PREDICTION_ROUNDS");
  if (raw === undefined || raw === "") return DEFAULT_MAX_PREDICTION_ROUNDS;
  const rounds = Number(raw);
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error("MAX_PREDICTION_ROUNDS must be a positive integer");
  }
  return rounds;
}
