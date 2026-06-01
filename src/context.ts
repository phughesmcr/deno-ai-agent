import { Chat, type LLM } from "@lmstudio/sdk";

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
  private compactPercentage: number = 0.75; // compact when the current token count is greater than 75% of the max context length
  private compactor: (chat: Chat) => Promise<Chat>;

  private model: LLM;

  /** Creates a context manager. */
  constructor({ model, maxContextLength, compactor }: ContextManagerOptions) {
    this.model = model;
    this.maxContextLength = maxContextLength;
    this.currentTokenCount = 0;
    this.complete = Chat.empty();
    this.current = Chat.empty();
    this.compactor = compactor;
  }

  /** Returns a mutable copy of the current chat. */
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

  /** Appends a message to the current chat. */
  async append(role: "user" | "assistant" | "system", content: string): Promise<ContextManager> {
    const chat = { role, content };
    this.complete.append(role, content);
    this.current.append(role, content);

    // if the current token count is greater than the max context length, we need to compact
    const tokenCount = await this.model.countTokens(chat.content);
    console.log(`Token count: ${tokenCount}, string: ${chat.content}`);
    this.currentTokenCount += tokenCount;
    console.log(
      `Current token count: ${this.currentTokenCount} (${
        Math.round((this.currentTokenCount / this.maxContextLength) * 100)
      }%)`,
    );

    if (this.currentTokenCount > this.maxContextLength * this.compactPercentage) {
      await this.compact();
    }

    return this;
  }

  private async refreshTokenCount(): Promise<void> {
    const messages = this.current.getMessagesArray();
    const promises = messages.map((message) => this.model.countTokens(message.toString()));
    const counts = await Promise.all(promises);
    this.currentTokenCount = counts.reduce((acc, count) => acc + count, 0);
  }

  /** Compacts the current chat via the configured compactor. */
  async compact(): Promise<ContextManager> {
    this.current = await this.compactor(this.current);
    await this.refreshTokenCount();
    return this;
  }
}
