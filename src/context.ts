import { Chat, type ChatMessageLike, type LLM } from "@lmstudio/sdk";

interface ContextManagerOptions {
  model: LLM;
  maxContextLength: number;
  compactor: (chat: Chat) => Promise<Chat>;
}

/** Manages chat history with token counting and compaction. */
export class ContextManager {
  private complete: Chat;
  private current: Chat;

  private maxContextLength: number;
  private currentTokenCount: number;
  private model: LLM;
  private compactor: (chat: Chat) => Promise<Chat>;

  /** Creates a context manager. */
  constructor({ model, maxContextLength, compactor }: ContextManagerOptions) {
    this.model = model;
    this.maxContextLength = maxContextLength;
    this.currentTokenCount = 0;
    this.complete = Chat.empty();
    this.current = Chat.empty();
    this.compactor = compactor;
  }

  /** @internal */
  get(): Chat {
    return this.current.asMutableCopy();
  }

  /** Replaces the system prompt in the current and complete history. */
  replaceSystemPrompt(prompt: string): ContextManager {
    // replace the system prompt in current
    this.current.replaceSystemPrompt(prompt);
    // add a new system message in complete
    this.complete.append({ role: "system", content: prompt });
    return this;
  }

  /** @internal */
  async append(chat: ChatMessageLike): Promise<ContextManager> {
    // complete gets everything
    this.complete.append(chat);

    // count the tokens in the current chat
    const tokenCount = await this.model.countTokens(chat.toString());
    this.currentTokenCount += tokenCount;

    // if the current token count is greater than the max context length, we need to compact
    if (this.currentTokenCount > this.maxContextLength) {
      await this.compact();
    }

    this.current.append(chat);

    return this;
  }

  /** Compacts the current chat via the configured compactor. */
  async compact(): Promise<ContextManager> {
    this.current = await this.compactor(this.current);
    return this;
  }
}
