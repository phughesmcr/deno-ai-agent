import { GrammyError, HttpError } from "grammy";
import { createSummaryCompactor } from "./src/context/compactor.ts";
import { ContextManager } from "./src/context/context.ts";
import { createLMStudioManager } from "./src/lmstudio.ts";
import { logDebug } from "./src/log.ts";
import { createActSpanTracker, recordActDuration, recordTelegramMessage, tokenBucket, traceSpan } from "./src/otel.ts";
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

  telegram.bot.command("new", async (ctx: TelegramContext) => {
    if (!ctx.config.isAdmin) {
      await ctx.reply("Sorry, you are not authorized to use this bot.");
      return;
    }
    context.reset();
    await ctx.reply("Context reset.");
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

          const userMessage = context.append("user", message);

          const typingInterval = setInterval(() => {
            ctx.replyWithChatAction("typing").catch(() => {});
          }, 4000);
          await ctx.replyWithChatAction("typing", {
            message_thread_id: ctx.message?.message_thread_id,
          });

          const tokenCountPromises: Promise<number>[] = [context.appendTokenCount(userMessage)];
          let replies = 0;
          const actStarted = performance.now();
          let firstTokenMs: number | undefined;

          try {
            await traceSpan(
              "lmstudio.act",
              async (actSpan) => {
                const actTelemetry = createActSpanTracker();
                await lmstudio.model.act(
                  context.get(),
                  toolsList,
                  {
                    onMessage: (msg) => {
                      actTelemetry.onMessage();
                      replies++;
                      const assistantMessage = context.append(msg);
                      tokenCountPromises.push(context.appendTokenCount(assistantMessage));
                    },
                    onFirstToken: (roundIndex) => {
                      const ms = performance.now() - actStarted;
                      if (firstTokenMs === undefined) firstTokenMs = ms;
                      actTelemetry.onFirstToken(roundIndex, ms);
                    },
                    onRoundStart: (roundIndex) => {
                      actTelemetry.onRoundStart(roundIndex);
                    },
                    onRoundEnd: (roundIndex) => {
                      actTelemetry.onRoundEnd(roundIndex);
                    },
                    onToolCallRequestDequeued: (roundIndex, callId) => {
                      actTelemetry.onToolCallRequestDequeued(roundIndex, callId);
                    },
                    onToolCallRequestEnd: (roundIndex, callId, info) => {
                      actTelemetry.onToolCallRequestEnd(
                        roundIndex,
                        callId,
                        info.toolCallRequest.name,
                        info.isQueued,
                      );
                    },
                    onToolCallRequestFailure: (_roundIndex, callId, error) => {
                      actTelemetry.onToolCallRequestFailure(callId, error.message);
                    },
                    onToolCallRequestFinalized: (_roundIndex, callId, info) => {
                      actTelemetry.onToolCallRequestFinalized(callId, info.toolCallRequest.name);
                    },
                    onToolCallRequestNameReceived: (_roundIndex, callId, name) => {
                      actTelemetry.onToolCallRequestNameReceived(callId, name);
                    },
                    onToolCallRequestStart: (roundIndex, callId, info) => {
                      actTelemetry.onToolCallRequestStart(roundIndex, callId, info.toolCallId);
                    },
                    signal: controller.signal,
                  },
                );
                const totalTokens = await Promise.all(tokenCountPromises);
                actSpan.setAttribute(
                  "context.tokens",
                  tokenBucket(totalTokens.reduce((acc, count) => acc + count, 0)),
                );
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
