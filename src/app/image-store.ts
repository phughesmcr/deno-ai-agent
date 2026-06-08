import type { DurableUserImage } from "../agent/user-turn.ts";
import type { QueuedDurableImage } from "./work-payload.ts";

const IMAGE_PREFIX: Deno.KvKey = ["app", "queued-images"];
const BASE64_CHUNK_CHARS = 48 * 1024;

interface QueuedImageStoreOptions {
  createId?: () => string;
}

function imageMetaKey(imageId: string): Deno.KvKey {
  return [...IMAGE_PREFIX, imageId, "meta"];
}

function imageChunkKey(imageId: string, index: number): Deno.KvKey {
  return [...IMAGE_PREFIX, imageId, "chunk", index];
}

function imageChunks(base64: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += BASE64_CHUNK_CHARS) {
    chunks.push(base64.slice(offset, offset + BASE64_CHUNK_CHARS));
  }
  return chunks;
}

/** Deno KV chunk store for queued Telegram image payloads. */
export class QueuedImageStore {
  private readonly _kv: Deno.Kv;
  private readonly _createId: () => string;

  constructor(kv: Deno.Kv, options: QueuedImageStoreOptions = {}) {
    this._kv = kv;
    this._createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** Stores image base64 in chunks and returns compact work-payload references. */
  async putImages(images: readonly DurableUserImage[]): Promise<QueuedDurableImage[]> {
    const refs: QueuedDurableImage[] = [];
    for (const image of images) {
      const imageId = this._createId();
      const chunks = imageChunks(image.base64);
      if (chunks.length === 0) throw new Error(`Image payload is empty: ${image.fileName}`);
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        if (chunk === undefined) continue;
        await this._kv.set(imageChunkKey(imageId, index), chunk);
      }
      const ref: QueuedDurableImage = { imageId, fileName: image.fileName, chunkCount: chunks.length };
      await this._kv.set(imageMetaKey(imageId), ref);
      refs.push(ref);
    }
    return refs;
  }

  /** Loads image references back into durable base64 payloads for LM Studio preparation. */
  async loadImages(refs: readonly QueuedDurableImage[]): Promise<DurableUserImage[]> {
    const images: DurableUserImage[] = [];
    for (const ref of refs) {
      const meta = await this._kv.get<QueuedDurableImage>(imageMetaKey(ref.imageId));
      if (!meta.value) throw new Error(`Queued image payload not found: ${ref.imageId}`);
      const chunks: string[] = [];
      for (let index = 0; index < ref.chunkCount; index += 1) {
        const chunk = await this._kv.get<string>(imageChunkKey(ref.imageId, index));
        if (typeof chunk.value !== "string") {
          throw new Error(`Queued image chunk missing: ${ref.imageId}/${index}`);
        }
        chunks.push(chunk.value);
      }
      images.push({ fileName: meta.value.fileName, base64: chunks.join("") });
    }
    return images;
  }

  /** Deletes queued image chunks and metadata after terminal work settlement. */
  async deleteImages(refs: readonly QueuedDurableImage[]): Promise<void> {
    for (const ref of refs) {
      for (let index = 0; index < ref.chunkCount; index += 1) {
        await this._kv.delete(imageChunkKey(ref.imageId, index));
      }
      await this._kv.delete(imageMetaKey(ref.imageId));
    }
  }
}
