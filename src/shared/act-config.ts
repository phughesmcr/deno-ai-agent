function modelId(): string {
  return Deno.env.get("MODEL") ?? "";
}

function defaultMaxPredictionRounds(): number {
  // LM Studio Gemma Jinja breaks when maxPredictionRounds > 1 (tool-loop template path).
  if (/gemma/i.test(modelId())) return 1;
  return 30;
}

/** `model.act()` `maxPredictionRounds` from `MAX_PREDICTION_ROUNDS` or model-specific default. */
export function getActMaxPredictionRounds(): number {
  const raw = Deno.env.get("MAX_PREDICTION_ROUNDS");
  if (raw === undefined || raw === "") return defaultMaxPredictionRounds();
  const rounds = Number(raw);
  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error("MAX_PREDICTION_ROUNDS must be a positive integer");
  }
  return rounds;
}
