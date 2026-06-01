import { Chat, type LLM } from "@lmstudio/sdk";

const KEEP_RECENT_MESSAGES = 6;

const SUMMARY_PROMPT =
  "Summarize the following conversation history concisely. Preserve facts, decisions, and open questions. Output only the summary.";

/** Compacts chat history by summarizing older turns and keeping recent messages. */
export function createSummaryCompactor(model: LLM, signal?: AbortSignal): (chat: Chat) => Promise<Chat> {
  return async (chat: Chat): Promise<Chat> => {
    const messages = chat.getMessagesArray();
    if (messages.length <= KEEP_RECENT_MESSAGES + 1) return chat;

    const systemPrompt = chat.getSystemPrompt();
    const toSummarize = messages.slice(0, -KEEP_RECENT_MESSAGES);
    const recent = messages.slice(-KEEP_RECENT_MESSAGES);

    const transcript = toSummarize.map((m) => m.toString()).join("\n\n");
    const summaryChat = Chat.empty();
    if (systemPrompt) summaryChat.replaceSystemPrompt(systemPrompt);
    summaryChat.append("user", `${SUMMARY_PROMPT}\n\n${transcript}`);

    let summary = "";
    await model.act(summaryChat, [], {
      onMessage: (msg) => {
        summary = msg.getText();
      },
      signal,
    });

    const compacted = Chat.empty();
    if (systemPrompt) compacted.replaceSystemPrompt(systemPrompt);
    compacted.append("user", `[Earlier conversation summary]\n${summary.trim()}`);
    for (const message of recent) {
      const role = message.getRole();
      if (role === "user" || role === "assistant" || role === "system") {
        compacted.append(role, message.getText());
      }
    }
    return compacted;
  };
}
