import { Chat, ChatMessage, type ChatMessageData, type LLM } from "@lmstudio/sdk";

import { logDebug } from "../log.ts";
import { traceSpan } from "../otel.ts";

/** @internal SDK exposes getRaw() at runtime but not in public types. */
type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

function messageToData(message: ChatMessage): ChatMessageData {
  return (message as ChatMessageWithRaw).getRaw();
}

function countTokensForMessage(model: LLM, message: ChatMessage): Promise<number> {
  return model.countTokens(message.toString());
}

interface ChatContextOptions {
  model: LLM;
  maxContextLength: number;
  compactPercentage?: number;
  compactor: (chat: Chat) => Promise<Chat>;
}

/**
 * LM Studio chat history: messages, token budget, compaction.
 * @internal
 */
export class ChatContext {
  #chat: Chat;
  readonly #maxContextLength: number;
  readonly #compactPercentage: number;
  readonly #compactor: (chat: Chat) => Promise<Chat>;
  readonly #model: LLM;
  #tokenCount = 0;

  constructor(spec: ChatContextOptions) {
    this.#chat = Chat.empty();
    this.#model = spec.model;
    this.#maxContextLength = spec.maxContextLength;
    this.#compactPercentage = spec.compactPercentage ?? 0.75;
    this.#compactor = spec.compactor;
  }

  get maxContextLength(): number {
    return this.#maxContextLength;
  }

  get messageCount(): number {
    return this.#chat.getMessagesArray().length;
  }

  get tokenCount(): number {
    return this.#tokenCount;
  }

  get shouldCompact(): boolean {
    return this.#tokenCount > this.#maxContextLength * this.#compactPercentage;
  }

  /** Mutable copy for `model.act`. */
  snapshot(): Chat {
    return this.#chat.asMutableCopy();
  }

  replaceSystemPrompt(prompt: string): void {
    this.#chat.replaceSystemPrompt(prompt);
  }

  append(chat: ChatMessage): ChatMessage;
  append(role: "user" | "assistant" | "system", content: string): ChatMessage;
  append(chatOrRole: ChatMessage | ("user" | "assistant" | "system"), content?: string): ChatMessage {
    const message = chatOrRole instanceof ChatMessage ? chatOrRole : ChatMessage.create(chatOrRole, content ?? "");
    this.#chat.append(message);
    logDebug("chat.append", {
      role: message.getRole(),
      text: message.getText(),
    });
    return message;
  }

  async refreshTokenCount(): Promise<number> {
    const messages = this.#chat.getMessagesArray();
    const counts = await Promise.all(messages.map((m) => countTokensForMessage(this.#model, m)));
    this.#tokenCount = counts.reduce((sum, n) => sum + n, 0);
    return this.#tokenCount;
  }

  async compact(): Promise<void> {
    await traceSpan("context.compact", async (span) => {
      const before = this.#tokenCount;
      this.#chat = await this.#compactor(this.#chat);
      await this.refreshTokenCount();
      span.setAttributes({
        "context.tokens.before": before,
        "context.tokens.after": this.#tokenCount,
      });
      logDebug("context.compact", { before, after: this.#tokenCount });
    });
  }

  clear(): void {
    this.#chat = Chat.empty();
    this.#tokenCount = 0;
  }

  loadMessages(messages: ChatMessageData[]): void {
    this.clear();
    this.#chat = Chat.from({ messages });
  }

  exportMessages(): ChatMessageData[] {
    return this.#chat.getMessagesArray().map(messageToData);
  }
}
