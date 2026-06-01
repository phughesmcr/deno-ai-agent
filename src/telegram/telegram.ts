import { Bot, type Context, GrammyError, HttpError } from "grammy";
import type { SessionManager } from "../context/session.ts";
import { logDebug } from "../log.ts";
import { SESSION_HELP, TelegramCommandHandler } from "./commands.ts";
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

function sessionArg(ctx: TelegramContext): string | undefined {
  return ctx.message?.text?.split(/\s+/)[1];
}

/**
 * Creates and configures the Telegram bot from environment variables.
 * @internal
 */
export function createTelegramManager({ session }: { session: SessionManager }): TelegramManager {
  const { token, adminId } = getEnv();

  const bot = new Bot<TelegramContext>(token);
  const commands = new TelegramCommandHandler(session);

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
      await ctx.reply(`Hello, admin!\n\n${SESSION_HELP}`);
    } else {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(commands.help());
  });

  bot.command("new", async (ctx: TelegramContext) => {
    await ctx.reply(commands.newSession());
  });

  bot.command("session", async (ctx: TelegramContext) => {
    await ctx.reply(commands.session());
  });

  bot.command("stats", async (ctx: TelegramContext) => {
    await ctx.reply(await commands.stats());
  });

  bot.command("fork", async (ctx: TelegramContext) => {
    await ctx.reply(await commands.fork());
  });

  async function handleLoad(ctx: TelegramContext): Promise<void> {
    await ctx.reply(await commands.load(sessionArg(ctx)));
  }

  bot.command("load", handleLoad);
  bot.command("resume", handleLoad);

  bot.command("save", async (ctx: TelegramContext) => {
    await ctx.reply(await commands.save());
  });

  bot.command("list", async (ctx: TelegramContext) => {
    await ctx.reply(await commands.list());
  });

  return { bot };
}
