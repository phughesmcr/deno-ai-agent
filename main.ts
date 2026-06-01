import type { Tool } from "@lmstudio/sdk";

import { createAgent, runTurn } from "./src/agent.ts";
import { createLMStudioManager } from "./src/lmstudio.ts";
import { logDebug } from "./src/log.ts";
import { recordActDuration, recordTelegramMessage, traceSpan } from "./src/otel.ts";
import { replyWithModelText } from "./src/telegram/telegram-reply.ts";
import { createTelegramManager, type TelegramContext } from "./src/telegram/telegram.ts";
import { getModelTools } from "./src/tools.ts";
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

  const workspace = await createWorkspace(new URL(".", import.meta.url));
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });
  const agent = await createAgent({ workspace, lmstudio, maxContextLength, signal: controller.signal });

  const toolsList = getModelTools({ root: workspace.path }) as Tool[];

  const telegram = createTelegramManager({ session: agent.session });

  registerShutdown(controller, async () => {
    await telegram.bot.stop();
    workspace[Symbol.dispose]();
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
            "session.id": agent.session.id,
            "tools.count": toolsList.length,
          });

          const actStarted = performance.now();
          try {
            const { replyTexts, compacted } = await runTurn(agent, message, {
              tools: toolsList,
              signal: controller.signal,
            });

            if (replyTexts.length > 0) {
              await replyWithModelText(
                ctx,
                replyTexts.join("\n"),
                ctx.message.message_id,
                ctx.message.message_thread_id,
              );
            }

            if (compacted) {
              logDebug("session.compacted", { sessionId: agent.session.id });
            }
          } finally {
            actMs = performance.now() - actStarted;
          }
        },
        { root: true },
      );
    } catch (error) {
      outcome = "error";
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
