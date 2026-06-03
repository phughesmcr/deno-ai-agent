import type { Tool } from "@lmstudio/sdk";

import {
  createAgent,
  createLMStudioManager,
  createSkillManager,
  createToolContext,
  createWorkspace,
  getModelTools,
  runTurn,
  SubagentManager,
  updateTelegramMeta,
} from "./src/agent/mod.ts";
import {
  assertPermissionBrokerSupported,
  runPermissionControlClient,
  shouldRunPermissionControlClient,
  waitForPermissionControlClient,
} from "./src/permission-broker/mod.ts";
import {
  ApprovalDeniedError,
  logDebug,
  recordActDuration,
  recordTelegramMessage,
  traceSpan,
} from "./src/shared/mod.ts";
import {
  ActiveTurnRegistry,
  createTelegramApprovalGate,
  createTelegramAskUserQuestionPort,
  createTelegramManager,
  createTelegramPermissionPromptPort,
  createTelegramTodoDisplayPort,
  isBotCommand,
  replyError,
  replyWithModelText,
  startTelegramBot,
  type TelegramContext,
  withTurnMutex,
} from "./src/telegram/mod.ts";

const PENDING_INTERACTION_HINT =
  "Please resolve the pending approval or permission prompt first (or wait for it to time out).";

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

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

async function main(): Promise<void> {
  if (Deno.env.get("DENO_PERMISSION_BROKER_PATH")) {
    assertPermissionBrokerSupported();
  }

  const controller = new AbortController();
  const { maxContextLength } = getEnv();

  const userQuestions = createTelegramAskUserQuestionPort();
  const permissionPrompts = createTelegramPermissionPromptPort(permissionPromptTimeoutMs());
  const approvals = createTelegramApprovalGate();

  if (shouldRunPermissionControlClient()) {
    const controlPath = Deno.env.get("SILAS_PERMISSION_CONTROL_PATH")!;
    const brokerPath = Deno.env.get("DENO_PERMISSION_BROKER_PATH") ?? "";
    console.log(`Silas connecting to permission broker\n  broker:  ${brokerPath}\n  control: ${controlPath}`);
    void runPermissionControlClient({ controlPath, promptPort: permissionPrompts }, controller.signal);
    await waitForPermissionControlClient();
    console.log("Permission broker control channel registered.");
  }

  const workspace = await createWorkspace(new URL(".", import.meta.url));
  console.log("Loading LM Studio model...");
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });
  console.log(`LM Studio model loaded (${Deno.env.get("MODEL") ?? "unknown"}).`);
  const agent = await createAgent({ workspace, lmstudio, maxContextLength, signal: controller.signal });
  const subagentKv = await Deno.openKv(":memory:");

  const bindUpdateTelegramMeta = (sessionId: string, meta: Parameters<typeof updateTelegramMeta>[2]) =>
    updateTelegramMeta(workspace.todosDir, sessionId, meta);
  const todoDisplay = createTelegramTodoDisplayPort({ updateTelegramMeta: bindUpdateTelegramMeta });
  let activeTurnId = "no-active-turn";
  const activeTurns = new ActiveTurnRegistry();
  const toolContext = await createToolContext(workspace.path, {
    approvalGate: approvals,
    sessionId: () => agent.session.id,
    turnId: () => activeTurnId,
    signal: () => activeTurns.actSignal ?? controller.signal,
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
    turnAbort: activeTurns,
    todosDir: workspace.todosDir,
    updateTelegramMeta: bindUpdateTelegramMeta,
  });

  let telegramRunner: ReturnType<typeof startTelegramBot> | undefined;

  registerShutdown(controller, async () => {
    await telegramRunner?.stop();
    await telegram.bot.stop();
    await subagents.shutdown();
    subagentKv.close();
    workspace[Symbol.dispose]();
  });

  telegram.bot.on("message", async (ctx: TelegramContext) => {
    if (userQuestions.isPending() || permissionPrompts.isPending() || approvals.isPending()) {
      if (ctx.message) {
        await ctx.reply(PENDING_INTERACTION_HINT, {
          message_thread_id: ctx.message.message_thread_id,
        });
      }
      return;
    }

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

          logDebug("telegram.message.received", {
            updateId: String(ctx.update.update_id),
            length: String(message.length),
          });
          console.log(`Telegram message received (${message.length} chars).`);

          try {
            await ctx.api.sendChatAction(ctx.chat!.id, "typing", {
              message_thread_id: ctx.message.message_thread_id,
            });
          } catch {
            /* typing indicator is best-effort */
          }

          try {
            await ctx.reply("Working on it…", {
              message_thread_id: ctx.message.message_thread_id,
            });
          } catch {
            /* best-effort ack while the model turn runs */
          }

          await withTurnMutex(async () => {
            const toolsList = await createTurnTools();
            span.setAttribute("tools.count", toolsList.length);
            activeTurnId = String(ctx.update.update_id);

            // LM Studio may abort the act signal mid-turn; approvals must use a separate signal.
            const turnController = new AbortController();
            const approvalController = new AbortController();
            const onShutdown = (): void => {
              turnController.abort();
              approvalController.abort();
            };
            controller.signal.addEventListener("abort", onShutdown);
            const clearActiveTurn = activeTurns.setActiveTurn({
              id: activeTurnId,
              actController: turnController,
              approvalController,
            });

            userQuestions.setTurnContext({ ctx, signal: turnController.signal });
            permissionPrompts.setTurnContext({ ctx, signal: approvalController.signal });
            todoDisplay.setTurnContext({ ctx, signal: turnController.signal });
            approvals.setTurnContext({ ctx, signal: approvalController.signal });
            const actStarted = performance.now();
            try {
              console.log("Model turn started.");
              const { replyTexts, compacted } = await runTurn(agent, message, {
                tools: toolsList,
                signal: turnController.signal,
              });
              console.log(`Model turn finished (${replyTexts.length} reply chunk(s)).`);

              if (ctx.message) {
                if (replyTexts.length > 0) {
                  await replyWithModelText(
                    ctx,
                    replyTexts,
                    ctx.message.message_id,
                    ctx.message.message_thread_id,
                  );
                } else {
                  await ctx.reply("The model finished without a reply. Try again or rephrase.", {
                    message_thread_id: ctx.message.message_thread_id,
                  });
                }
              }

              if (compacted) {
                logDebug("session.compacted", { sessionId: agent.session.id });
              }
            } finally {
              actMs = performance.now() - actStarted;
              clearActiveTurn();
              controller.signal.removeEventListener("abort", onShutdown);
              approvalController.abort();
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
      if (
        isAbortError(error) ||
        (error instanceof ApprovalDeniedError && error.decision.reason === "cancelled")
      ) {
        outcome = "ok";
        if (ctx.message) {
          await ctx.reply("Turn aborted.", { message_thread_id: ctx.message.message_thread_id });
        }
        return;
      }
      if (error instanceof ApprovalDeniedError && ctx.message) {
        await ctx.reply(
          `Operation not approved (${error.decision.reason}). Target: ${error.request.target}`,
          { message_thread_id: ctx.message.message_thread_id },
        );
        return;
      }
      logDebug("telegram.message.error", {
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(error);
      if (ctx.message) {
        await replyError(ctx, ctx.message.message_thread_id);
      }
    } finally {
      recordTelegramMessage(outcome, skipped);
      recordActDuration(actMs, outcome);
    }
  });

  await traceSpan("telegram.bot.start", async () => {
    telegramRunner = startTelegramBot(telegram.bot);
    console.log("Silas ready — listening on Telegram.");
    await telegramRunner.task();
  }, { root: true });
}

if (import.meta.main) {
  void main();
}
