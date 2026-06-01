import { type LLM, LMStudioClient } from "@lmstudio/sdk";

export interface LMStudioManager {
  readonly client: LMStudioClient;
  readonly model: LLM;
}

interface LMStudioManagerOptions {
  signal?: AbortSignal;
  maxContextLength: number;
}

/**
 * Creates an LM Studio client and loads the configured local model.
 * @internal
 */
export async function createLMStudioManager(spec: LMStudioManagerOptions): Promise<LMStudioManager> {
  const { signal, maxContextLength } = spec;
  const modelName = Deno.env.get("MODEL");
  if (!modelName) throw new Error("MODEL is not set");
  const client = new LMStudioClient();
  const model = await client.llm.model(modelName, { signal, config: { contextLength: maxContextLength } });
  return { client, model };
}
