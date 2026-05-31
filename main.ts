import type { Chat } from "@lmstudio/sdk";
import { ContextManager } from "./src/context.ts";
import { createLMStudioManager } from "./src/lmstudio.ts";
import { stripThinking } from "./src/markdown.ts";
import { TelegramManager } from "./src/telegram.ts";
import { ToolsManager } from "./src/tools.ts";

if (import.meta.main) {
  void main();
}

async function main(): Promise<void> {
  const controller = new AbortController();

  const maxContextLength = 65_536;
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });
  const context = new ContextManager({
    model: lmstudio.model,
    maxContextLength,
    compactor: (c: Chat) => Promise.resolve(c),
  });

  const telegram = new TelegramManager();

  const tools = new ToolsManager();
  const toolsList = tools.get() ?? [];

  telegram.bot.on("message", async (ctx) => {
    const message = ctx.message.text;
    if (!message) return;
    let reply = "";
    await lmstudio.model.act(message, toolsList, {
      onMessage: (msg) => {
        context.append(msg);
        reply += msg.toString();
      },
    });
    const normalizedResponse = stripThinking(reply.toString());
    await ctx.reply(normalizedResponse, {
      reply_parameters: {
        message_id: ctx.message.message_id,
      },
      parse_mode: "MarkdownV2",
    });
  });

  await telegram.bot.start();
}
