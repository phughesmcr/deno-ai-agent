import { Bot, type Context } from "grammy";

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
export function createTelegramManager(): TelegramManager {
  const { token, adminId } = getEnv();

  const bot = new Bot<TelegramContext>(token);

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

  return { bot };
}
