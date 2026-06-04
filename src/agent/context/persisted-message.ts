import { ChatMessage, type ChatMessageData } from "@lmstudio/sdk";

import { getReasoningConfig, persistedModelText } from "../../shared/reasoning.ts";

/** @internal SDK exposes getRaw() at runtime but not in public types. */
type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

function messageData(message: ChatMessage): ChatMessageData {
  return (message as ChatMessageWithRaw).getRaw();
}

/**
 * Assistant message shaped for session chat and JSONL persistence.
 * @internal
 */
export function chatMessageForPersistence(message: ChatMessage): ChatMessage {
  if (getReasoningConfig().keepThinking || message.getRole() !== "assistant") return message;

  const data = messageData(message);
  let changed = false;
  const content = data.content.map((part) => {
    if (part.type !== "text") return part;
    const text = persistedModelText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });

  return changed ? ChatMessage.from({ ...data, content } as ChatMessageData) : message;
}
