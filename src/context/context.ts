import { Chat, ChatMessage, type LLM } from "@lmstudio/sdk";

import { logDebug } from "../log.ts";
import { traceSpan } from "../otel.ts";

interface ContextManagerOptions {
  complete?: Chat;
  current?: Chat;
  compactPercentage?: number;
  model: LLM;
  maxContextLength: number;
  compactor: (chat: Chat) => Promise<Chat>;
}

/**
 * Manages chat history with token counting and compaction.
 * @internal
 */
export class ContextManager {
  private complete: Chat;
  private current: Chat;

  private maxContextLength: number;
  private currentTokenCount: number;
  private compactPercentage: number; // compact when the current token count is greater than 75% of the max context length
  private compactor: (chat: Chat) => Promise<Chat>;

  private model: LLM;

  /** Creates a context manager. */
  constructor(spec: ContextManagerOptions) {
    const { complete, current, compactPercentage, model, maxContextLength, compactor } = spec;
    this.model = model;
    this.maxContextLength = maxContextLength;
    this.complete = complete ?? Chat.empty();
    this.current = current ?? Chat.empty();
    this.currentTokenCount = 0;
    this.compactPercentage = compactPercentage ?? 0.75;
    this.compactor = compactor;
  }

  /** Whether the current token count exceeds the compaction threshold. */
  get shouldCompact(): boolean {
    return this.currentTokenCount > this.maxContextLength * this.compactPercentage;
  }

  /** Returns a mutable copy of the current chat. */
  get(): Chat {
    return this.current.asMutableCopy();
  }

  /** Approximate token count for the current chat (for telemetry). */
  getTokenCount(): number {
    return this.currentTokenCount;
  }

  /** Replaces the system prompt in the current and complete history. */
  replaceSystemPrompt(prompt: string): ContextManager {
    this.current.replaceSystemPrompt(prompt);
    this.complete.append({ role: "system", content: prompt });
    return this;
  }

  /** Adds a message's token count to the running total. */
  async appendTokenCount(chat: ChatMessage): Promise<ContextManager> {
    const tokenCount = await this.model.countTokens(chat.getText());
    this.currentTokenCount += tokenCount;
    return this;
  }

  /** Appends a chat message to the current and complete history. */
  append(chat: ChatMessage): void;
  /** Appends a message with the given role and content. */
  append(role: "user" | "assistant" | "system", content: string): void;
  append(chatOrRole: ChatMessage | ("user" | "assistant" | "system"), content?: string): void {
    const chat = chatOrRole instanceof ChatMessage ? chatOrRole : ChatMessage.create(chatOrRole, content ?? "");
    this.complete.append(chat);
    this.current.append(chat);
    logDebug("context.append", {
      role: chat.getRole(),
      text: chat.getText(),
      toolCallRequests: chat.getToolCallRequests().map((request) => JSON.stringify(request)).join(","),
      toolCallResults: chat.getToolCallResults().map((result) => JSON.stringify(result)).join(","),
      isUserMessage: chat.isUserMessage() ? "yes" : "no",
      isAssistantMessage: chat.isAssistantMessage() ? "yes" : "no",
      isSystemPrompt: chat.isSystemPrompt() ? "yes" : "no",
    });
  }

  /** Recalculates the current token count. */
  async refreshTokenCount(): Promise<void> {
    const messages = this.current.getMessagesArray();
    const promises = messages.map((message) => this.model.countTokens(message.toString()));
    const counts = await Promise.all(promises);
    this.currentTokenCount = counts.reduce((acc, count) => acc + count, 0);
  }

  /** Compacts the current chat via the configured compactor. */
  async compact(): Promise<ContextManager> {
    await traceSpan("context.compact", async (span) => {
      const before = this.currentTokenCount;
      this.current = await this.compactor(this.current);
      await this.refreshTokenCount();
      span.setAttributes({
        "context.tokens.before": before,
        "context.tokens.after": this.currentTokenCount,
      });
      logDebug("context.compact", { before, after: this.currentTokenCount });
    });
    return this;
  }
}
