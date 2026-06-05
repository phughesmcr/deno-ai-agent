import { Bot, type Context, GrammyError, HttpError } from "grammy";

import { questions, type QuestionsFlavor } from "grammy-questions";
import type { AskUserQuestionPort, TodoStore } from "../agent/mod.ts";
import type { PermissionCallbackDispatch } from "../permission-broker/mod.ts";
import { loadTelegramConfig, logDebug } from "../shared/mod.ts";
import { shouldIgnoreUnauthorizedMessage } from "./authorization.ts";
import { installConcurrentUpdates } from "./bot-runner.ts";
import { type CommandCronManager, SESSION_HELP, TelegramCommandHandler } from "./commands.ts";
import { type TelegramConversationRef, telegramConversationRef } from "./conversation.ts";
import { showTodosForSession } from "./grammy-todo-display-adapter.ts";
import { isPermissionCallback } from "./permission-callback.ts";
import type { TelegramSessionCoordinator } from "./session-coordinator.ts";
import { replyError } from "./telegram-reply.ts";

interface BotConfig {
  adminId: number;
  isAdmin: boolean;
}

/**
 * Grammy context extended with bot configuration.
 * @internal
 */
export type TelegramContext = QuestionsFlavor<
  Context & {
    config: BotConfig;
  }
>;

interface TelegramManager {
  readonly bot: Bot<TelegramContext>;
}

interface TelegramApprovalPort {
  isPending(): boolean;
  handleCallback(ctx: TelegramContext): Promise<boolean>;
}

interface TelegramTurnAbortPort {
  abortActiveTurn(): boolean;
}

interface TelegramPermissionPromptPort {
  isPending(): boolean;
  handleCallback(
    data: string,
    actorId: number | undefined,
    adminId: number,
  ): Promise<PermissionCallbackDispatch>;
}

interface TelegramCronTopicPort {
  createTopic(name: string): Promise<{ threadId: number; topicName: string }>;
}

function getEnv(): { token: string; adminId: number } {
  const config = loadTelegramConfig();
  return { token: config.TELEGRAM_BOT_TOKEN, adminId: config.TELEGRAM_ADMIN_ID };
}

/** Bot token for Telegram file downloads (shared with {@link createTelegramManager}). */
export function getTelegramBotToken(): string {
  return getEnv().token;
}

function sessionArg(ctx: TelegramContext): string | undefined {
  return ctx.message?.text?.split(/\s+/)[1];
}

function commandRest(ctx: TelegramContext): string | undefined {
  const text = ctx.message?.text ?? "";
  const rest = text.replace(/^\/\S+\s*/, "").trim();
  return rest.length > 0 ? rest : undefined;
}

const PENDING_INTERACTION_HINT = "Please resolve the pending question or approval first.";

function replyThreadId(ctx: TelegramContext): number | undefined {
  return ctx.message?.message_thread_id;
}

async function replyInConversation(ctx: TelegramContext, text: string): Promise<void> {
  await ctx.reply(text, { message_thread_id: replyThreadId(ctx) });
}

/**
 * Creates and configures the Telegram bot from environment variables.
 * @internal
 */
export function createTelegramManager({
  sessions,
  onAdminStart,
  userQuestions,
  permissionPrompts,
  approvals,
  turnAbort,
  todoStore,
  cronForConversation,
}: {
  sessions: TelegramSessionCoordinator;
  onAdminStart: (ctx: TelegramContext) => Promise<void>;
  userQuestions?: AskUserQuestionPort;
  permissionPrompts?: TelegramPermissionPromptPort;
  approvals?: TelegramApprovalPort;
  turnAbort?: TelegramTurnAbortPort;
  todoStore?: TodoStore;
  cronForConversation?: (ref: TelegramConversationRef, topics: TelegramCronTopicPort) => CommandCronManager | undefined;
}): TelegramManager {
  const { token, adminId } = getEnv();

  const bot = new Bot<TelegramContext>(token);

  function commandsFor(ctx: TelegramContext): TelegramCommandHandler | undefined {
    const ref = telegramConversationRef(ctx);
    if (!ref) return undefined;
    return new TelegramCommandHandler(
      sessions.forConversation(ref, { createdBy: ctx.from?.id }),
      todoStore,
      cronForConversation?.(ref, {
        createTopic: async (name) => {
          if (!ctx.chat) throw new Error("No Telegram chat found for topic creation.");
          const topic = await ctx.api.createForumTopic(ctx.chat.id, name);
          return { threadId: topic.message_thread_id, topicName: name };
        },
      }),
    );
  }

  bot.catch(async (err) => {
    const ctx = err.ctx;
    logDebug("telegram.error", { update_id: ctx.update.update_id });
    const e = err.error;
    if (e instanceof GrammyError) {
      logDebug("telegram.grammy_error", { description: e.description });
    } else if (e instanceof HttpError) {
      logDebug("telegram.http_error", { message: String(e) });
    } else {
      logDebug("telegram.unknown_error", { message: String(e) });
    }
    if (ctx.config.isAdmin && ctx.message) {
      await replyError(ctx, ctx.message.message_thread_id);
    }
  });

  bot.use(async (ctx, next) => {
    ctx.config = {
      adminId: adminId,
      isAdmin: ctx.from?.id === adminId,
    };
    await next();
  });

  installConcurrentUpdates(bot);

  bot.on("message", async (ctx, next) => {
    if (!ctx.config.isAdmin) {
      if (shouldIgnoreUnauthorizedMessage(ctx)) return;
      await replyInConversation(ctx, "Sorry, you are not authorized to use this bot.");
      return;
    }
    await next();
  });

  bot.command("q", async (ctx: TelegramContext) => {
    const aborted = turnAbort?.abortActiveTurn() ?? false;
    await ctx.reply(aborted ? "Aborted current turn." : "No active turn.", {
      message_thread_id: replyThreadId(ctx),
    });
  });

  bot.use(
    questions({
      filter: (ctx) => ctx.config.isAdmin,
      getStorageKey: (ctx) => {
        const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? 0;
        return `silas-${ctx.chat?.id}-${threadId}`;
      },
    }),
  );

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (data && isPermissionCallback(data)) {
      const dispatch = await permissionPrompts?.handleCallback(data, ctx.from?.id, adminId);
      if (dispatch?.handled) {
        await ctx.answerCallbackQuery(dispatch.answer);
        if (dispatch.clearReplyMarkup || !permissionPrompts?.isPending()) {
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: undefined });
          } catch {
            /* message may be gone */
          }
        }
        return;
      }
    }
    if (await approvals?.handleCallback(ctx)) return;
    await next();
  });

  function blockIfInteractionPending(ctx: TelegramContext): boolean {
    if (userQuestions?.isPending() || permissionPrompts?.isPending() || approvals?.isPending()) {
      void replyInConversation(ctx, PENDING_INTERACTION_HINT);
      return true;
    }
    return false;
  }

  bot.command("start", async (ctx) => {
    if (ctx.config.isAdmin) {
      if (blockIfInteractionPending(ctx)) return;
      const ref = telegramConversationRef(ctx);
      if (!ref) {
        await replyInConversation(ctx, "No Telegram chat found for this command.");
        return;
      }
      const resolution = await sessions.ensure(ref, { createdBy: ctx.from?.id });
      if (resolution.created) await onAdminStart(ctx);
      const commands = commandsFor(ctx);
      if (!commands) return;
      await replyInConversation(ctx, `Hello, admin!\n\n${commands.help()}\n\n${await commands.session()}`);
    } else {
      await replyInConversation(ctx, "Sorry, you are not authorized to use this bot.");
    }
  });

  bot.command("help", async (ctx) => {
    const commands = commandsFor(ctx);
    await replyInConversation(ctx, commands?.help() ?? SESSION_HELP);
  });

  bot.command("new", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(ctx, commands ? await commands.newSession() : "No Telegram chat found for this command.");
  });

  bot.command("session", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(ctx, commands ? await commands.session() : "No Telegram chat found for this command.");
  });

  bot.command("stats", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(ctx, commands ? await commands.stats() : "No Telegram chat found for this command.");
  });

  bot.command("compact", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(
      ctx,
      commands ? await commands.compact(commandRest(ctx)) : "No Telegram chat found for this command.",
    );
  });

  bot.command("fork", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(ctx, commands ? await commands.fork() : "No Telegram chat found for this command.");
  });

  async function handleLoad(ctx: TelegramContext): Promise<void> {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(
      ctx,
      commands ? await commands.load(sessionArg(ctx)) : "No Telegram chat found for this command.",
    );
  }

  bot.command("load", handleLoad);
  bot.command("resume", handleLoad);

  bot.command("rename", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const name = commandRest(ctx)?.trim();
    const commands = commandsFor(ctx);
    await replyInConversation(
      ctx,
      commands ?
        await commands.rename(name && name.length > 0 ? name : undefined) :
        "No Telegram chat found for this command.",
    );
  });

  bot.command("save", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(ctx, commands ? await commands.save() : "No Telegram chat found for this command.");
  });

  bot.command("list", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(ctx, commands ? await commands.list() : "No Telegram chat found for this command.");
  });

  bot.command("topics", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(ctx, commands ? await commands.topics() : "No Telegram chat found for this command.");
  });

  bot.command("cron", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const commands = commandsFor(ctx);
    await replyInConversation(
      ctx,
      commands ? await commands.cron(commandRest(ctx)) : "No Telegram chat found for this command.",
    );
  });

  bot.command("topic", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const name = commandRest(ctx)?.trim();
    if (!name) {
      await replyInConversation(ctx, "Usage: /topic <name>");
      return;
    }
    if (!ctx.chat) {
      await replyInConversation(ctx, "No Telegram chat found for this command.");
      return;
    }
    try {
      const topic = await ctx.api.createForumTopic(ctx.chat.id, name);
      const ref = { chatId: ctx.chat.id, threadId: topic.message_thread_id };
      const status = await sessions.replaceWithNew(ref, { createdBy: ctx.from?.id, topicName: name });
      await ctx.api.sendMessage(
        ctx.chat.id,
        `Session ready.\nID: ${status.id}`,
        { message_thread_id: topic.message_thread_id },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await replyInConversation(ctx, `Topic creation failed: ${message}`);
    }
  });

  bot.command("todos", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    if (!todoStore) {
      await replyInConversation(ctx, "Todo list is not configured.");
      return;
    }
    const commands = commandsFor(ctx);
    if (!commands) {
      await replyInConversation(ctx, "No Telegram chat found for this command.");
      return;
    }
    try {
      const status = await commands.sessionStatus();
      await showTodosForSession(ctx, status.id, todoStore);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await replyInConversation(ctx, `Failed to show todos: ${message}`);
    }
  });

  return { bot };
}
