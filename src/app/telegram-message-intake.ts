import type { LMStudioClient } from "@lmstudio/sdk";
import type { Bot } from "grammy";

import { recordActDuration, type UserTurnInput } from "../agent/mod.ts";
import { errorMessage, isAbortError, logDebug, logError, logInfo, traceSpan } from "../shared/mod.ts";
import {
  AudioTooLargeError,
  type AudioTranscriber,
  botCommandName,
  createMediaGroupBuffer,
  DEFAULT_IMAGE_PROMPT,
  downloadTelegramMessageImage,
  durableTelegramImages,
  ImageTooLargeError,
  isBotCommand,
  type MediaGroupBuffer,
  parseTelegramUserTurn,
  prepareDurableUserImages,
  recordTelegramMessage,
  replyError,
  telegramAudioDuration,
  telegramAudioKind,
  type TelegramContext,
  UnsupportedAudioError,
  UnsupportedImageError,
} from "../telegram/mod.ts";
import type { SubmitTelegramUserTurnRequest, TelegramWorkIntake } from "./telegram-work-intake.ts";

const PENDING_INTERACTION_HINT =
  "Please resolve the pending Telegram question or capability prompt first (or wait for it to time out).";

function isImageInputError(error: unknown): boolean {
  return error instanceof ImageTooLargeError || error instanceof UnsupportedImageError;
}

function isAudioInputError(error: unknown): boolean {
  return error instanceof AudioTooLargeError || error instanceof UnsupportedAudioError;
}

/** Wiring for the Telegram message intake handler. */
export interface TelegramMessageIntakeOptions {
  /** GrammY bot to register the message handler on. */
  bot: Bot<TelegramContext>;
  /** Telegram bot token used for file downloads. */
  botToken: string;
  /** LM Studio client used to prepare image handles. */
  client: LMStudioClient;
  /** Optional voice/audio transcriber. */
  audioTranscriber?: AudioTranscriber;
  /** Durable work intake used to cancel queued conversation turns. */
  intake: Pick<TelegramWorkIntake, "cancelConversation">;
  /** Aborts the active turn and pending capability prompts. */
  abortActiveTurn(): boolean;
  /** Whether a user question or capability prompt is awaiting an answer. */
  isInteractionPending(): boolean;
  /** Session id messages should be queued against. */
  currentSessionId(): string;
  /** Durably enqueues one Telegram user turn. */
  submitUserTurn(request: SubmitTelegramUserTurnRequest): Promise<void>;
}

/**
 * Registers the Telegram `message` handler that turns incoming messages into
 * durable queued work, and returns the album buffer for shutdown disposal.
 */
export function registerTelegramMessageIntake(options: TelegramMessageIntakeOptions): MediaGroupBuffer {
  const { bot, botToken, client, audioTranscriber, intake } = options;

  const mediaGroupBuffer = createMediaGroupBuffer(async (payload) => {
    let outcome: "error" | "ok" = "ok";
    try {
      if (payload.items.length === 0) return;

      await traceSpan(
        "telegram.album.flush",
        async (span) => {
          span.setAttributes({
            "telegram.media_group_id": payload.mediaGroupId,
            "telegram.album.size": payload.items.length,
            "telegram.has_images": true,
            "telegram.image_count": payload.items.length,
            "telegram.chat_id": payload.context.chatId,
            ...(payload.context.threadId !== undefined ? { "telegram.thread_id": payload.context.threadId } : {}),
          });

          const durableImages = await durableTelegramImages(payload.items);
          const images = await prepareDurableUserImages(client, durableImages);
          const input: UserTurnInput = {
            text: payload.text ?? DEFAULT_IMAGE_PROMPT,
            images,
            durableImages,
          };

          logInfo(
            `Telegram album flush (${payload.items.length} image(s), media_group_id=${payload.mediaGroupId}).`,
          );

          await options.submitUserTurn({
            ctx: payload.turnCtx,
            input,
            replyToMessageId: payload.context.replyToMessageId,
            updateId: payload.turnCtx.update.update_id,
            sessionId: options.currentSessionId(),
          });
        },
        { root: true },
      );
    } catch (error) {
      outcome = "error";
      const ctx = payload.turnCtx;
      if (isImageInputError(error) && ctx.message) {
        await ctx.reply(errorMessage(error), { message_thread_id: ctx.message.message_thread_id });
        return;
      }
      logDebug("telegram.album.error", {
        message: errorMessage(error),
      });
      logError("telegram.album.exception", { message: errorMessage(error) });
      if (ctx.message) {
        await replyError(ctx, ctx.message.message_thread_id);
      }
    } finally {
      recordTelegramMessage(outcome, false);
      recordActDuration(0, outcome);
    }
  });

  bot.on("message", async (ctx: TelegramContext) => {
    if (ctx.message && isBotCommand(ctx.message) && botCommandName(ctx.message) === "q") {
      const aborted = options.abortActiveTurn();
      await intake.cancelConversation({
        target: {
          chatId: ctx.chat?.id ?? ctx.message.chat.id,
          ...(ctx.message.message_thread_id !== undefined ? { threadId: ctx.message.message_thread_id } : {}),
        },
        reason: "Turn aborted.",
        reply: { ctx, abortedActiveTurn: aborted },
      });
      return;
    }

    if (options.isInteractionPending()) {
      if (ctx.message) {
        await ctx.reply(PENDING_INTERACTION_HINT, {
          message_thread_id: ctx.message.message_thread_id,
        });
      }
      return;
    }

    let outcome: "error" | "ok" = "ok";
    let skipped = false;
    let recordMetrics = true;

    try {
      await traceSpan(
        "telegram.message",
        async (span) => {
          const message = ctx.message;
          if (!message || !ctx.chat) {
            skipped = true;
            span.setAttribute("skipped", true);
            span.setAttribute("skip.reason", "non_actionable");
            return;
          }

          if (isBotCommand(message)) {
            skipped = true;
            span.setAttribute("skipped", true);
            span.setAttribute("skip.reason", "bot_command");
            return;
          }

          const mediaGroupId = message.media_group_id;
          if (mediaGroupId) {
            recordMetrics = false;
            const item = await downloadTelegramMessageImage(ctx.api, botToken, message);
            mediaGroupBuffer.enqueue({
              mediaGroupId,
              turnCtx: ctx,
              context: {
                chatId: ctx.chat.id,
                threadId: message.message_thread_id,
                replyToMessageId: message.message_id,
              },
              item,
              caption: message.caption,
            });
            span.setAttributes({
              "telegram.media_group_id": mediaGroupId,
              "telegram.has_images": true,
            });
            logDebug("telegram.album.enqueue", { mediaGroupId });
            return;
          }

          if (message.text?.trim()) {
            mediaGroupBuffer.flushPendingForConversation({
              chatId: ctx.chat.id,
              ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
            });
          }

          let userInput: UserTurnInput | null;
          try {
            userInput = await parseTelegramUserTurn(ctx, client, botToken, audioTranscriber);
          } catch (error) {
            if (isImageInputError(error) || isAudioInputError(error)) {
              await ctx.reply(errorMessage(error), { message_thread_id: message.message_thread_id });
              return;
            }
            throw error;
          }

          if (!userInput) {
            skipped = true;
            span.setAttribute("skipped", true);
            span.setAttribute("skip.reason", "non_actionable");
            return;
          }

          const imageCount = userInput.images?.length ?? 0;
          const audioKind = telegramAudioKind(message);
          const audioDuration = telegramAudioDuration(message);
          span.setAttributes({
            "telegram.update_id": ctx.update.update_id,
            "message.length": userInput.text.length,
            "telegram.chat_id": ctx.chat.id,
            ...(message.message_thread_id !== undefined ? { "telegram.thread_id": message.message_thread_id } : {}),
            ...(imageCount > 0 ? { "telegram.has_images": true, "telegram.image_count": imageCount } : {}),
            ...(audioKind ? { "telegram.has_audio": true, "telegram.audio_kind": audioKind } : {}),
            ...(audioDuration !== undefined ? { "telegram.audio_duration": audioDuration } : {}),
          });

          logDebug("telegram.message.received", {
            updateId: String(ctx.update.update_id),
            length: String(userInput.text.length),
            ...(imageCount > 0 ? { imageCount: String(imageCount) } : {}),
            ...(audioKind ? { audioKind } : {}),
          });
          logInfo(
            `Telegram message received (${userInput.text.length} chars${
              imageCount > 0 ? `, ${imageCount} image(s)` : ""
            }${audioKind ? `, ${audioKind} audio` : ""}).`,
          );

          await options.submitUserTurn({
            ctx,
            input: userInput,
            replyToMessageId: message.message_id,
            updateId: ctx.update.update_id,
            sessionId: options.currentSessionId(),
          });
        },
        { root: true },
      );
    } catch (error) {
      outcome = "error";
      if (isAbortError(error)) {
        outcome = "ok";
        if (ctx.message) {
          await ctx.reply("Turn aborted.", { message_thread_id: ctx.message.message_thread_id });
        }
        return;
      }
      if ((isImageInputError(error) || isAudioInputError(error)) && ctx.message) {
        await ctx.reply(errorMessage(error), { message_thread_id: ctx.message.message_thread_id });
        return;
      }
      logDebug("telegram.message.error", {
        message: errorMessage(error),
      });
      logError("telegram.message.exception", { message: errorMessage(error) });
      if (ctx.message) {
        await replyError(ctx, ctx.message.message_thread_id);
      }
    } finally {
      if (recordMetrics) {
        recordTelegramMessage(outcome, skipped);
        recordActDuration(0, outcome);
      }
    }
  });

  return mediaGroupBuffer;
}
