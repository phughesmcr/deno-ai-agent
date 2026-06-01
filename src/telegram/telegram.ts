import { Bot, type Context, GrammyError, HttpError } from "grammy";
import type { SessionManager } from "../context/session.ts";
import { logDebug } from "../log.ts";
import { replyError } from "./telegram-reply.ts";

const SESSION_HELP =
  "Sessions: /new - fresh chat | /save - write to disk | /load <id> - restore | /fork - branch copy | /list - saved ids | /session - status | /stats - tokens";

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

function formatStatus(session: SessionManager): string {
  const s = session.status();
  const filled = Math.round((s.tokenCount / s.maxContextLength) * 100);
  const persist = s.saved ? (s.dirty ? "saved (unsaved changes)" : "saved") : (s.dirty ? "not saved" : "empty");
  return [
    `Session: ${s.id}`,
    `State: ${persist}`,
    `Messages: ${s.messageCount}`,
    `Tokens: ${s.tokenCount} / ${s.maxContextLength} (${filled}%)`,
  ].join("\n");
}

/**
 * Creates and configures the Telegram bot from environment variables.
 * @internal
 */
export function createTelegramManager({ session }: { session: SessionManager }): TelegramManager {
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
      await ctx.reply(`Hello, admin!\n\n${SESSION_HELP}`);
    } else {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
    }
  });

  bot.command("help", async (ctx) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    await ctx.reply(SESSION_HELP);
  });

  bot.command("new", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    const id = session.newSession();
    await ctx.reply(`New session.\nID: ${id}\n\nUse /save to persist.`);
  });

  bot.command("session", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    await ctx.reply(formatStatus(session));
  });

  bot.command("stats", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    await session.chat.refreshTokenCount();
    await ctx.reply(formatStatus(session));
  });

  bot.command("fork", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    try {
      const { fromId, toId } = await session.fork();
      await ctx.reply(`Forked.\nFrom: ${fromId}\nTo: ${toId}\n\nUse /save on the new branch when ready.`);
    } catch (error) {
      await ctx.reply(`Fork failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  async function handleLoad(ctx: TelegramContext): Promise<void> {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    const id = sessionArg(ctx);
    if (!id) {
      await ctx.reply("Usage: /load <session-id>\n\n/list shows saved ids.");
      return;
    }
    try {
      await session.load(id);
      await ctx.reply(`Loaded session ${id}.\n\n${formatStatus(session)}`);
    } catch (error) {
      await ctx.reply(`Load failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  bot.command("load", handleLoad);
  bot.command("resume", handleLoad);

  bot.command("save", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    try {
      const id = await session.save();
      await ctx.reply(`Saved.\nID: ${id}`);
    } catch (error) {
      await ctx.reply(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command("list", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    const sessions = await session.list();
    if (sessions.length === 0) {
      await ctx.reply("No saved sessions. /save writes the current chat.");
      return;
    }
    const current = session.id;
    const lines = sessions.map((id) => (id === current ? `${id} (current)` : id));
    await ctx.reply(`Saved sessions:\n${lines.join("\n")}`);
  });

  return { bot };
}
