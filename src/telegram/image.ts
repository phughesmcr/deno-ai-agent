// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import type { FileHandle, LMStudioClient } from "@lmstudio/sdk";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import type { DurableUserImage } from "../agent/user-turn.ts";

/** Default user text when an image has no caption. */
export const DEFAULT_IMAGE_PROMPT = "Describe this image.";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BASE64_CHUNK_BYTES = 48 * 1024;
const BASE64_YIELD_EVERY_CHUNKS = 16;

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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  const chunks: string[] = [];
  let chunkCount = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_BYTES);
    chunks.push(btoa(String.fromCharCode(...chunk)));
    chunkCount += 1;
    if (
      chunkCount % BASE64_YIELD_EVERY_CHUNKS === 0 && offset + BASE64_CHUNK_BYTES < bytes.byteLength
    ) {
      await yieldToEventLoop();
    }
  }
  return chunks.join("");
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
  return await prepareDurableUserImages(client, await durableTelegramImages(items));
}

/** Converts Telegram image bytes into durable base64 payloads for queued work. */
export async function durableTelegramImages(items: TelegramImageItem[]): Promise<DurableUserImage[]> {
  const images: DurableUserImage[] = [];
  for (const item of items) {
    assertImageSize(item.bytes);
    images.push({ fileName: item.fileName, base64: await bytesToBase64(item.bytes) });
  }
  return images;
}

/** Uploads durable image payloads to LM Studio and returns handles for the model. */
export async function prepareDurableUserImages(
  client: LMStudioClient,
  images: readonly DurableUserImage[],
): Promise<FileHandle[]> {
  const handles: FileHandle[] = [];
  for (const image of images) {
    const handle = await client.files.prepareImageBase64(image.fileName, image.base64);
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
