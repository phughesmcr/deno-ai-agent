import type { Tool } from "@lmstudio/sdk";

import { createAgent, runTurn } from "./src/agent.ts";
import { createLMStudioManager } from "./src/lmstudio.ts";
import { logDebug } from "./src/log.ts";
import { recordActDuration, recordTelegramMessage, traceSpan } from "./src/otel.ts";
import {
  runPermissionControlClient,
  shouldRunPermissionControlClient,
} from "./src/permission-broker/control-client.ts";
import { assertPermissionBrokerSupported } from "./src/permission-broker/version.ts";
import { SubagentManager } from "./src/subagents.ts";
import { createTelegramApprovalGate } from "./src/telegram/approval-gate.ts";
import { createTelegramPermissionPromptPort } from "./src/telegram/grammy-permission-prompt-adapter.ts";
import { createTelegramAskUserQuestionPort } from "./src/telegram/grammy-questions-adapter.ts";
import { createTelegramTodoDisplayPort } from "./src/telegram/grammy-todo-display-adapter.ts";
import { isBotCommand } from "./src/telegram/is-bot-command.ts";
import { replyWithModelText } from "./src/telegram/telegram-reply.ts";
import { createTelegramManager, type TelegramContext } from "./src/telegram/telegram.ts";
import { withTurnMutex } from "./src/telegram/turn-gate.ts";
import { createSkillManager, createToolContext, getModelTools } from "./src/tools.ts";
import { updateTelegramMeta } from "./src/tools/todo-write.ts";
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

function permissionPromptTimeoutMs(): number {
  const value = Number(Deno.env.get("PERMISSION_PROMPT_TIMEOUT_MS") ?? "120000");
  return Number.isFinite(value) ? value : 120_000;
}

async function main(): Promise<void> {
  if (Deno.env.get("DENO_PERMISSION_BROKER_PATH")) {
    assertPermissionBrokerSupported();
  }

  const controller = new AbortController();
  const { maxContextLength } = getEnv();

  const workspace = await createWorkspace(new URL(".", import.meta.url));
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });
  const agent = await createAgent({ workspace, lmstudio, maxContextLength, signal: controller.signal });
  const subagentKv = await Deno.openKv(":memory:");

  const userQuestions = createTelegramAskUserQuestionPort();
  const permissionPrompts = createTelegramPermissionPromptPort(permissionPromptTimeoutMs());
  const approvals = createTelegramApprovalGate();
  const bindUpdateTelegramMeta = (sessionId: string, meta: Parameters<typeof updateTelegramMeta>[2]) =>
    updateTelegramMeta(workspace.todosDir, sessionId, meta);
  const todoDisplay = createTelegramTodoDisplayPort({ updateTelegramMeta: bindUpdateTelegramMeta });
  let activeTurnId = "no-active-turn";
  const toolContext = await createToolContext(workspace.path, {
    approvalGate: approvals,
    sessionId: () => agent.session.id,
    turnId: () => activeTurnId,
    signal: controller.signal,
  });
  const skills = await createSkillManager({ root: workspace.path });
  const subagents = new SubagentManager({
    kv: subagentKv,
    model: lmstudio.model,
    workspace: toolContext,
    skills,
    getSessionId: () => agent.session.id,
  });
  const createTurnTools = async (): Promise<Tool[]> => {
    await skills.refresh();
    return getModelTools({
      workspace: toolContext,
      userQuestions,
      todos: {
        getSessionId: () => agent.session.id,
        todosDir: workspace.todosDir,
        display: todoDisplay,
        updateTelegramMeta: bindUpdateTelegramMeta,
      },
      skills: {
        manager: skills,
        getSessionId: () => agent.session.id,
      },
      subagents,
    }) as Tool[];
  };

  const telegram = createTelegramManager({
    session: agent.session,
    userQuestions,
    permissionPrompts,
    approvals,
    todosDir: workspace.todosDir,
    updateTelegramMeta: bindUpdateTelegramMeta,
  });

  if (shouldRunPermissionControlClient()) {
    const controlPath = Deno.env.get("SILAS_PERMISSION_CONTROL_PATH")!;
    void runPermissionControlClient({ controlPath, promptPort: permissionPrompts }, controller.signal);
  }

  registerShutdown(controller, async () => {
    await telegram.bot.stop();
    await subagents.shutdown();
    subagentKv.close();
    workspace[Symbol.dispose]();
  });

  telegram.bot.on("message", async (ctx: TelegramContext) => {
    if (userQuestions.isPending() || permissionPrompts.isPending() || approvals.isPending()) return;

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

          if (isBotCommand(ctx.message)) {
            skipped = true;
            span.setAttribute("skipped", true);
            span.setAttribute("skip.reason", "bot_command");
            return;
          }

          span.setAttributes({
            "telegram.update_id": ctx.update.update_id,
            "message.length": message.length,
            "session.id": agent.session.id,
          });

          await withTurnMutex(async () => {
            const toolsList = await createTurnTools();
            span.setAttribute("tools.count", toolsList.length);
            activeTurnId = String(ctx.update.update_id);
            userQuestions.setTurnContext({ ctx, signal: controller.signal });
            permissionPrompts.setTurnContext({ ctx, signal: controller.signal });
            todoDisplay.setTurnContext({ ctx, signal: controller.signal });
            approvals.setTurnContext({ ctx, signal: controller.signal });
            const actStarted = performance.now();
            try {
              const { replyTexts, compacted } = await runTurn(agent, message, {
                tools: toolsList,
                signal: controller.signal,
              });

              if (replyTexts.length > 0 && ctx.message) {
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
              userQuestions.clearTurnContext();
              permissionPrompts.clearTurnContext();
              todoDisplay.clearTurnContext();
              approvals.clearTurnContext();
              activeTurnId = "no-active-turn";
            }
          });
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
