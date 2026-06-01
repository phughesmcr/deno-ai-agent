import { Bot, type Context, GrammyError, HttpError } from "grammy";
import type { ContextManager } from "../context/context.ts";
import { logDebug } from "../log.ts";
import { replyError } from "./telegram-reply.ts";

interface BotConfig {
  adminId: number;
  isAdmin: boolean;
}

/**
 * Grammy context extended with bot configuration.
 * @internal
 */
export type TelegramContext = Context & {
  config: BotConfig;
};

interface TelegramManager {
  readonly bot: Bot<TelegramContext>;
}

function getEnv(): { token: string; adminId: number } {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const adminIdRaw = Deno.env.get("TELEGRAM_ADMIN_ID")!;
  if (!adminIdRaw) throw new Error("TELEGRAM_ADMIN_ID is not set");

  const adminId = Number(adminIdRaw);
  if (isNaN(adminId)) throw new Error("TELEGRAM_ADMIN_ID is not a number");

  return { token, adminId };
}

/**
 * Creates and configures the Telegram bot from environment variables.
 * @internal
 */
export function createTelegramManager({ context }: { context: ContextManager }): TelegramManager {
  const { token, adminId } = getEnv();

  const bot = new Bot<TelegramContext>(token);

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

  bot.on("message", async (ctx, next) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    if (ctx.config.isAdmin) {
      await ctx.reply("Hello, admin!");
    } else {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
    }
  });

  bot.command("new", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    context.reset();
    await ctx.reply("Context reset.");
  });

  bot.command("stats", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    const tokenCount = context.currentTokenCount;
    const filled = Math.round((tokenCount / context.maxContextLength) * 100);
    await ctx.reply(`Context: ${tokenCount} tokens (${filled}% filled)`);
  });

  return { bot };
}
