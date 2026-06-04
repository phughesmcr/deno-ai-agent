// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import { logDebug } from "../shared/log.ts";
import { telegramConversationKey, type TelegramConversationRef } from "./conversation.ts";
import type { TelegramImageItem } from "./telegram-image.ts";
import type { TelegramContext } from "./telegram.ts";

const ALBUM_DEBOUNCE_MS = 600;
const MAX_ALBUM_IMAGES = 10;

/** Context needed to run a model turn after an album flush. */
export interface AlbumFlushContext {
  chatId: number;
  threadId?: number;
  replyToMessageId: number;
}

/** Payload delivered when a media group is flushed. */
export interface AlbumFlushPayload {
  mediaGroupId: string;
  context: AlbumFlushContext;
  /** Grammy context from the first photo in the album (for turn ports and replies). */
  turnCtx: TelegramContext;
  items: TelegramImageItem[];
  text?: string;
}

interface AlbumState {
  mediaGroupId: string;
  context: AlbumFlushContext;
  turnCtx: TelegramContext;
  items: TelegramImageItem[];
  text?: string;
  flushTimer?: ReturnType<typeof setTimeout>;
}

/** Buffers Telegram album photos into one debounced turn. */
export interface MediaGroupBuffer extends Disposable {
  /** Queues one downloaded image for an album. */
  enqueue(payload: {
    mediaGroupId: string;
    context: AlbumFlushContext;
    turnCtx: TelegramContext;
    item: TelegramImageItem;
    caption?: string;
  }): void;
  /** Flushes any pending album for the conversation before handling text. */
  flushPendingForConversation(ref: TelegramConversationRef): void;
  /** Clears pending timers (app shutdown). */
  dispose(): void;
}

/**
 * Creates a buffer that debounces `media_group_id` photos into one callback.
 * @internal
 */
export function createMediaGroupBuffer(
  onFlush: (payload: AlbumFlushPayload) => void | Promise<void>,
): MediaGroupBuffer {
  const albums = new Map<string, AlbumState>();
  const conversationToGroup = new Map<string, string>();

  function albumKey(context: AlbumFlushContext, mediaGroupId: string): string {
    return `${telegramConversationKey(context)}:${mediaGroupId}`;
  }

  function clearTimer(state: AlbumState): void {
    if (state.flushTimer !== undefined) clearTimeout(state.flushTimer);
  }

  function removeAlbum(key: string): void {
    const state = albums.get(key);
    if (!state) return;
    clearTimer(state);
    albums.delete(key);
    conversationToGroup.delete(telegramConversationKey(state.context));
  }

  function scheduleFlush(key: string, state: AlbumState): void {
    clearTimer(state);
    state.flushTimer = setTimeout(() => {
      void Promise.try(async () => {
        const payload: AlbumFlushPayload = {
          mediaGroupId: state.mediaGroupId,
          context: state.context,
          turnCtx: state.turnCtx,
          items: state.items,
          text: state.text,
        };
        removeAlbum(key);
        await onFlush(payload);
      });
    }, ALBUM_DEBOUNCE_MS);
  }

  function dispose(): void {
    for (const state of albums.values()) clearTimer(state);
    albums.clear();
    conversationToGroup.clear();
  }

  return {
    enqueue({ mediaGroupId, context, turnCtx, item, caption }): void {
      const key = albumKey(context, mediaGroupId);
      let state = albums.get(key);
      if (!state) {
        const created: AlbumState = {
          mediaGroupId,
          context,
          turnCtx,
          items: [],
        };
        albums.set(key, created);
        conversationToGroup.set(telegramConversationKey(context), key);
        state = created;
      }

      if (state.items.length < MAX_ALBUM_IMAGES) {
        state.items.push(item);
      } else {
        logDebug("telegram.album.cap", { mediaGroupId, max: MAX_ALBUM_IMAGES });
      }

      const trimmed = caption?.trim();
      if (trimmed && !state.text) state.text = trimmed;

      scheduleFlush(key, state);
    },

    flushPendingForConversation(ref): void {
      const key = conversationToGroup.get(telegramConversationKey(ref));
      if (!key) return;
      const state = albums.get(key);
      if (!state) return;
      clearTimer(state);
      void Promise.try(async () => {
        const payload: AlbumFlushPayload = {
          mediaGroupId: state.mediaGroupId,
          context: state.context,
          turnCtx: state.turnCtx,
          items: state.items,
          text: state.text,
        };
        removeAlbum(key);
        await onFlush(payload);
      });
    },

    dispose,

    [Symbol.dispose](): void {
      dispose();
    },
  };
}
