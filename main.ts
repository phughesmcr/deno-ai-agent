import { GrammyError, HttpError } from "grammy";

import { createSummaryCompactor } from "./src/context/compactor.ts";
import { ContextManager } from "./src/context/context.ts";
import { createLMStudioManager } from "./src/lmstudio.ts";
import { logDebug } from "./src/log.ts";
import { recordActDuration, recordTelegramMessage, tokenBucket, traceSpan } from "./src/otel.ts";
import { replyError, replyWithModelText } from "./src/telegram/telegram-reply.ts";
import { createTelegramManager, type TelegramContext } from "./src/telegram/telegram.ts";
import { ToolsManager } from "./src/tools.ts";
import { createWorkspace } from "./src/workspace.ts";

function getEnv(): { maxContextLength: number } {
  const maxContextLength = Number(Deno.env.get("CONTEXT_LENGTH"));
  if (isNaN(maxContextLength)) throw new Error("CONTEXT_LENGTH is not a number");
  if (maxContextLength <= 0) throw new Error("CONTEXT_LENGTH must be greater than 0");
  return { maxContextLength };
}

function registerShutdown(controller: AbortController, stop: () => Promise<void>): void {
  const shutdown = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    void stop().finally(() => Deno.exit(0));
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const controller = new AbortController();

  const { maxContextLength } = getEnv();
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });

  const context = new ContextManager({
    model: lmstudio.model,
    maxContextLength,
    compactor: createSummaryCompactor(lmstudio.model, controller.signal),
  });

  using workspace = await createWorkspace(new URL(".", import.meta.url), (event) => {
    if (event.kind === "modify" && event.paths.at(-1)?.endsWith("SYSTEM.md")) {
      context.replaceSystemPrompt(workspace.systemPrompt);
      logDebug("workspace.system_prompt_changed");
    }
  });

  context.replaceSystemPrompt(workspace.systemPrompt);

  const tools = new ToolsManager();
  const toolsList = tools.get() ?? [];

  const telegram = createTelegramManager();

  registerShutdown(controller, () => telegram.bot.stop());

  telegram.bot.catch(async (err) => {
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

  telegram.bot.on("message", async (ctx: TelegramContext) => {
    let outcome: "error" | "ok" = "ok";
    let skipped = false;
    let actMs = 0;

    try {
      await traceSpan(
        "telegram.message",
        async (span) => {
          const message = ctx.message?.text;
          if (!ctx.message || !message) {
            skipped = true;
            span.setAttribute("skipped", true);
            span.setAttribute("skip.reason", "non_text");
            return;
          }

          span.setAttributes({
            "telegram.update_id": ctx.update.update_id,
            "message.length": message.length,
            "tools.count": toolsList.length,
          });

          await context.append("user", message);
          span.setAttribute("context.tokens", tokenBucket(context.getTokenCount()));

          const typingInterval = setInterval(() => {
            ctx.replyWithChatAction("typing").catch(() => {});
          }, 4000);
          await ctx.replyWithChatAction("typing", {
            message_thread_id: ctx.message?.message_thread_id,
          });

          const tokenCountPromises: Promise<ContextManager>[] = [];
          let replies = 0;
          const actStarted = performance.now();
          let firstTokenMs: number | undefined;

          try {
            await traceSpan(
              "lmstudio.act",
              async (actSpan) => {
                await lmstudio.model.act(
                  context.get(),
                  toolsList,
                  {
                    onMessage: (msg) => {
                      replies++;
                      context.append(msg);
                      tokenCountPromises.push(context.appendTokenCount(msg));
                    },
                    onFirstToken: () => {
                      if (firstTokenMs === undefined) firstTokenMs = performance.now() - actStarted;
                    },
                    signal: controller.signal,
                  },
                );
                if (replies > 0) {
                  await Promise.all(tokenCountPromises);
                }
                actSpan.setAttribute("reply.count", replies);
                if (firstTokenMs !== undefined) actSpan.setAttribute("first_token.ms", Math.round(firstTokenMs));
              },
              { attributes: { "tools.count": toolsList.length } },
            );
          } finally {
            actMs = performance.now() - actStarted;
            clearInterval(typingInterval);
          }

          await replyWithModelText(
            ctx,
            context.get().getMessagesArray().map((msg) => msg.getText()).join("\n"),
            ctx.message.message_id,
            ctx.message.message_thread_id,
          );

          if (context.shouldCompact) {
            await context.compact();
            // TODO: notify user of compaction
          }
        },
        { root: true },
      );
    } catch (error) {
      outcome = "error";
      if (ctx.message?.text && ctx.config.isAdmin) {
        try {
          await replyError(ctx, ctx.message.message_thread_id);
        } catch {
          // bot.catch will handle a second failure
        }
      }
      throw error;
    } finally {
      recordTelegramMessage(outcome, skipped);
      recordActDuration(actMs, outcome);
    }
  });

  await traceSpan("telegram.bot.start", async () => {
    await telegram.bot.start();
  }, { root: true });
}

if (import.meta.main) {
  void main();
}
