import { Chat, type ChatMessage, type LLM } from "@lmstudio/sdk";

const KEEP_RECENT_MESSAGES = 6;
const SKILL_CONTENT_PATTERN = /<skill_content name="([^"]+)">[\s\S]*?<\/skill_content>/g;

const SUMMARY_PROMPT =
  "Summarize the following conversation history concisely. Preserve facts, decisions, and open questions. Output only the summary.";

interface SkillContentBlock {
  content: string;
  order: number;
}

function skillContentSources(message: ChatMessage): string[] {
  const sources = message.getToolCallResults().map((result) => result.content);
  const text = message.getText();
  if (text) sources.push(text);
  return sources;
}

function messageContainsSkillContent(message: ChatMessage): boolean {
  return skillContentSources(message).some((source) => source.includes("<skill_content name="));
}

function extractLatestSkillContent(messages: ChatMessage[]): string[] {
  const latest = new Map<string, SkillContentBlock>();
  let order = 0;

  for (const message of messages) {
    for (const source of skillContentSources(message)) {
      for (const match of source.matchAll(SKILL_CONTENT_PATTERN)) {
        const name = match[1];
        const content = match[0];
        if (!name || !content) continue;
        latest.set(name, { content, order });
        order += 1;
      }
    }
  }

  return [...latest.values()]
    .toSorted((a, b) => a.order - b.order)
    .map((block) => block.content);
}

/**
 * Compacts chat history by summarizing older turns and keeping recent messages.
 * @internal
 */
export function createSummaryCompactor(model: LLM, signal?: AbortSignal): (chat: Chat) => Promise<Chat> {
  return async (chat: Chat): Promise<Chat> => {
    const messages = chat.getMessagesArray();
    if (messages.length <= KEEP_RECENT_MESSAGES + 1) return chat;

    const systemPrompt = chat.getSystemPrompt();
    const skillBlocks = extractLatestSkillContent(messages);
    const messagesWithoutSkillContent = skillBlocks.length > 0 ?
      messages.filter((message) => !messageContainsSkillContent(message)) :
      messages;
    const toSummarize = messagesWithoutSkillContent.slice(0, -KEEP_RECENT_MESSAGES);
    const recent = messagesWithoutSkillContent.slice(-KEEP_RECENT_MESSAGES);

    let summary = "";
    if (toSummarize.length > 0) {
      const transcript = toSummarize.map((m) => m.toString()).join("\n\n");
      const summaryChat = Chat.empty();
      if (systemPrompt) summaryChat.replaceSystemPrompt(systemPrompt);
      summaryChat.append("user", `${SUMMARY_PROMPT}\n\n${transcript}`);

      await model.act(summaryChat, [], {
        onMessage: (msg) => {
          summary = msg.getText();
        },
        signal,
      });
    }

    const compacted = Chat.empty();
    if (systemPrompt) compacted.replaceSystemPrompt(systemPrompt);
    if (summary.trim()) compacted.append("user", `[Earlier conversation summary]\n${summary.trim()}`);
    if (skillBlocks.length > 0) {
      compacted.append("user", `[Loaded skill context]\n${skillBlocks.join("\n\n")}`);
    }
    for (const message of recent) {
      compacted.append(message);
    }
    return compacted;
  };
}
