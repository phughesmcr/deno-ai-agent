import { Bot, type Context, GrammyError, HttpError } from "grammy";

import { questions, type QuestionsFlavor } from "grammy-questions";
import type { AgentSessions, AskUserQuestionPort, TodoTelegramMeta } from "../agent/mod.ts";
import type { PermissionCallbackDispatch } from "../permission-broker/mod.ts";
import { loadTelegramConfig, logDebug } from "../shared/mod.ts";
import { installConcurrentUpdates } from "./bot-runner.ts";
import { TelegramCommandHandler } from "./commands.ts";
import { showTodosForSession } from "./grammy-todo-display-adapter.ts";
import { isPermissionCallback } from "./permission-callback.ts";
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

/**
 * Creates and configures the Telegram bot from environment variables.
 * @internal
 */
export function createTelegramManager({
  session,
  onAdminStart,
  userQuestions,
  permissionPrompts,
  approvals,
  turnAbort,
  todosDir,
  updateTelegramMeta,
}: {
  session: AgentSessions;
  onAdminStart: (ctx: TelegramContext) => Promise<void>;
  userQuestions?: AskUserQuestionPort;
  permissionPrompts?: TelegramPermissionPromptPort;
  approvals?: TelegramApprovalPort;
  turnAbort?: TelegramTurnAbortPort;
  todosDir?: string;
  updateTelegramMeta?: (sessionId: string, meta: TodoTelegramMeta) => Promise<void>;
}): TelegramManager {
  const { token, adminId } = getEnv();

  const bot = new Bot<TelegramContext>(token);
  const commands = new TelegramCommandHandler(session, todosDir);

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
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    await next();
  });

  bot.command("q", async (ctx: TelegramContext) => {
    const aborted = turnAbort?.abortActiveTurn() ?? false;
    await ctx.reply(aborted ? "Aborted current turn." : "No active turn.", {
      message_thread_id: ctx.message?.message_thread_id,
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
      void ctx.reply(PENDING_INTERACTION_HINT);
      return true;
    }
    return false;
  }

  bot.command("start", async (ctx) => {
    if (ctx.config.isAdmin) {
      if (blockIfInteractionPending(ctx)) return;
      await ctx.reply(commands.newSession());
      await onAdminStart(ctx);
    } else {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(commands.help());
  });

  bot.command("new", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    await ctx.reply(commands.newSession());
  });

  bot.command("session", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    await ctx.reply(await commands.session());
  });

  bot.command("stats", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    await ctx.reply(await commands.stats());
  });

  bot.command("compact", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    await ctx.reply(await commands.compact(commandRest(ctx)));
  });

  bot.command("fork", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    await ctx.reply(await commands.fork());
  });

  async function handleLoad(ctx: TelegramContext): Promise<void> {
    if (blockIfInteractionPending(ctx)) return;
    await ctx.reply(await commands.load(sessionArg(ctx)));
  }

  bot.command("load", handleLoad);
  bot.command("resume", handleLoad);

  bot.command("rename", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    const name = commandRest(ctx)?.trim();
    await ctx.reply(await commands.rename(name && name.length > 0 ? name : undefined));
  });

  bot.command("save", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    await ctx.reply(await commands.save());
  });

  bot.command("list", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    await ctx.reply(await commands.list());
  });

  bot.command("todos", async (ctx: TelegramContext) => {
    if (blockIfInteractionPending(ctx)) return;
    if (!todosDir || !updateTelegramMeta) {
      await ctx.reply("Todo list is not configured.");
      return;
    }
    try {
      await showTodosForSession(ctx, session.current.id, todosDir, updateTelegramMeta);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to show todos: ${message}`);
    }
  });

  return { bot };
}
