import { type LLM, LMStudioClient } from "@lmstudio/sdk";

/** Creates an {@link LMStudioManager} connected to the configured local model. */
export async function createLMStudioManager(
  { signal, maxContextLength }: { signal?: AbortSignal; maxContextLength: number },
): Promise<LMStudioManager> {
  const client = new LMStudioClient();
  const model = await client.llm.model("qwen3.6-27b", { signal, config: { contextLength: maxContextLength } });
  return new LMStudioManager(client, model);
}

/** Wraps an LM Studio client and loaded LLM model. */
export class LMStudioManager {
  /** @internal */
  readonly client: LMStudioClient;
  /** @internal */
  readonly model: LLM;

  /** Creates a manager from a client and model. */
  constructor(client: LMStudioClient, model: LLM) {
    this.client = client;
    this.model = model;
  }
}
