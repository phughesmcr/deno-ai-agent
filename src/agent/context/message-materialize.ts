import {
  ChatMessage,
  type ChatMessageData,
  type ChatMessagePartFileData,
  type FileHandle,
  type LMStudioClient,
} from "@lmstudio/sdk";

/** SDK exposes rehydration at runtime; not on public `FilesNamespace` types. */
interface FilesNamespaceWithRehydrate {
  createFileHandleFromChatMessagePartFileData(part: ChatMessagePartFileData): FileHandle;
}

const PLACEHOLDER_PREFIX = "[Image attachment:";

export function imageFileParts(data: ChatMessageData): ChatMessagePartFileData[] {
  return data.content.flatMap((part) => part.type === "file" && part.fileType === "image" ? [part] : []);
}

function placeholderLine(name: string): string {
  return `${PLACEHOLDER_PREFIX} ${name} - not available after reload]`;
}

function textOnlyData(data: ChatMessageData): ChatMessageData {
  const textParts = data.content.flatMap((part) => part.type === "text" ? [part] : []);
  return { role: data.role, content: textParts } as ChatMessageData;
}

/**
 * Rebuilds a chat message from persisted data, rehydrating image file parts when LM Studio still has them.
 * @internal
 */
export function materializeMessageForChat(client: LMStudioClient, data: ChatMessageData): ChatMessage {
  const images = imageFileParts(data);
  if (images.length === 0) return ChatMessage.from(data);

  const message = ChatMessage.from(textOnlyData(data));
  for (const part of images) {
    try {
      const handle = (client.files as unknown as FilesNamespaceWithRehydrate)
        .createFileHandleFromChatMessagePartFileData(part);
      message.appendFile(handle);
    } catch {
      message.appendText(`\n${placeholderLine(part.name)}`);
    }
  }
  return message;
}

/** Whether serialized message data still carries image file parts. @internal */
export function hasImageFileParts(data: ChatMessageData): boolean {
  return imageFileParts(data).length > 0;
}
