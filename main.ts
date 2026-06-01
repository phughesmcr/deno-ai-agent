import type { Chat } from "@lmstudio/sdk";
import { GrammyError, HttpError } from "grammy";

import { ContextManager } from "./src/context.ts";
import { createLMStudioManager } from "./src/lmstudio.ts";
import { stripThinking } from "./src/markdown.ts";
import { createTelegramManager, type TelegramContext } from "./src/telegram.ts";
import { ToolsManager } from "./src/tools.ts";
import { createWorkspace } from "./src/workspace.ts";

function getEnv(): { maxContextLength: number } {
  const maxContextLength = Number(Deno.env.get("CONTEXT_LENGTH"));
  if (isNaN(maxContextLength)) throw new Error("CONTEXT_LENGTH is not a number");
  if (maxContextLength <= 0) throw new Error("CONTEXT_LENGTH must be greater than 0");
  return { maxContextLength };
}

async function main(): Promise<void> {
  const controller = new AbortController();

  const { maxContextLength } = getEnv();
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });

  const context = new ContextManager({
    model: lmstudio.model,
    maxContextLength,
    compactor: (c: Chat) => Promise.resolve(c),
  });

  using workspace = await createWorkspace(new URL(".", import.meta.url), (event) => {
    // watch for changes to the system prompt
    if (event.kind === "modify" && event.paths.at(-1)?.endsWith("SYSTEM.md")) {
      context.replaceSystemPrompt(workspace.systemPrompt);
      console.log("System prompt changed.");
    }
  });

  context.replaceSystemPrompt(workspace.systemPrompt);

  const tools = new ToolsManager();
  const toolsList = tools.get() ?? [];

  const telegram = createTelegramManager();

  telegram.bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error("Error in request:", e.description);
    } else if (e instanceof HttpError) {
      console.error("Could not contact Telegram:", e);
    } else {
      console.error("Unknown error:", e);
    }
  });

  telegram.bot.on("message", async (ctx: TelegramContext) => {
    const message = ctx.message?.text;
    if (!ctx.message || !message) return;
    context.append("user", message);

    const replies: string[] = [];
    await lmstudio.model.act(context.get(), toolsList, {
      onMessage: (msg) => {
        const reply = msg.getText();
        context.append("assistant", reply);
        replies.push(reply);
      },
      onFirstToken: () => {
        void ctx.replyWithChatAction("typing", { message_thread_id: ctx.message?.message_thread_id });
      },
    });

    await ctx.reply(stripThinking(replies.join("\n")), {
      reply_parameters: {
        message_id: ctx.message!.message_id,
      },
      parse_mode: "MarkdownV2",
    });

    // console.log(JSON.stringify(context.get().getMessagesArray()));
  });

  await telegram.bot.start();
}

if (import.meta.main) {
  void main();
}
