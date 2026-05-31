import { Bot } from "grammy";

function createGrammyBot(): Bot {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  const bot = new Bot(token);
  bot.command("start", (ctx) => ctx.reply("Hello, world!"));
  return bot;
}

/** Manages the Telegram bot instance. */
export class TelegramManager {
  /** @internal */
  readonly bot: Bot;

  /** Creates a Telegram manager from environment configuration. */
  constructor() {
    this.bot = createGrammyBot();
  }
}
