// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import type { FileHandle, LMStudioClient } from "@lmstudio/sdk";
import type { Api } from "grammy";
import type { Message } from "grammy/types";

/** Default user text when an image has no caption. */
export const DEFAULT_IMAGE_PROMPT = "Describe this image.";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Image bytes plus filename for LM Studio upload. */
export interface TelegramImageItem {
  bytes: Uint8Array;
  fileName: string;
}

/** Thrown when a Telegram image exceeds the size limit. */
export class ImageTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`Image is too large (${byteLength} bytes, max ${MAX_IMAGE_BYTES})`);
    this.name = "ImageTooLargeError";
  }
}

/** Thrown when a message has no supported image attachment. */
export class UnsupportedImageError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UnsupportedImageError";
  }
}

/** Returns a Telegram `file_id` for a photo or image document, if present. */
export function extractImageFileId(message: Message): string | undefined {
  const photos = message.photo;
  if (photos && photos.length > 0) {
    return photos.at(-1)?.file_id;
  }

  const document = message.document;
  if (document?.mime_type && SUPPORTED_IMAGE_MIMES.has(document.mime_type)) {
    return document.file_id;
  }

  return undefined;
}

/** Infers a filename for LM Studio from Telegram metadata. */
export function inferImageFileName(
  filePath: string,
  mimeType?: string,
  documentFileName?: string,
): string {
  if (documentFileName && /\.(jpe?g|png|webp)$/i.test(documentFileName)) {
    return documentFileName;
  }

  const fromPath = filePath.split("/").pop();
  if (fromPath && /\.(jpe?g|png|webp)$/i.test(fromPath)) return fromPath;

  if (mimeType === "image/png") return "telegram.png";
  if (mimeType === "image/webp") return "telegram.webp";
  return "telegram.jpg";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Downloads a file from Telegram Bot API storage. */
export async function downloadTelegramFile(
  api: Api,
  botToken: string,
  fileId: string,
): Promise<{ bytes: Uint8Array; filePath: string; mimeType?: string }> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new UnsupportedImageError("Telegram file has no path");
  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new UnsupportedImageError(`Failed to download Telegram file (${response.status})`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, filePath: file.file_path };
}

function assertImageSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ImageTooLargeError(bytes.byteLength);
}

/** Uploads Telegram image bytes to LM Studio and returns handles for the model. */
export async function prepareTelegramImages(
  client: LMStudioClient,
  items: TelegramImageItem[],
): Promise<FileHandle[]> {
  const handles: FileHandle[] = [];
  for (const item of items) {
    assertImageSize(item.bytes);
    const handle = await client.files.prepareImageBase64(item.fileName, bytesToBase64(item.bytes));
    handles.push(handle);
  }
  return handles;
}

/** Downloads one image attachment from a Telegram message. */
export async function downloadTelegramMessageImage(
  api: Api,
  botToken: string,
  message: Message,
): Promise<TelegramImageItem> {
  const fileId = extractImageFileId(message);
  if (!fileId) throw new UnsupportedImageError("Message has no supported image attachment");

  const { bytes, filePath } = await downloadTelegramFile(api, botToken, fileId);
  const fileName = inferImageFileName(
    filePath,
    message.document?.mime_type,
    message.document?.file_name,
  );
  return { bytes, fileName };
}
