import type { Tool } from "@lmstudio/sdk";

import {
  createAgent,
  createLMStudioManager,
  createSkillManager,
  createToolContext,
  createWorkspace,
  getModelTools,
  normalizeUserTurnInput,
  readBootstrapIfPresent,
  recordActDuration,
  runTurn,
  SubagentManager,
  updateTelegramMeta,
  type UserTurnInput,
} from "./src/agent/mod.ts";
import {
  assertPermissionBrokerSupported,
  runPermissionControlClient,
  shouldRunPermissionControlClient,
  waitForPermissionControlClient,
} from "./src/permission-broker/mod.ts";
import { ApprovalDeniedError, logDebug, traceSpan } from "./src/shared/mod.ts";
import { SESSION_HELP } from "./src/telegram/commands.ts";
import {
  ActiveTurnRegistry,
  botCommandName,
  createMediaGroupBuffer,
  createTelegramApprovalGate,
  createTelegramAskUserQuestionPort,
  createTelegramManager,
  createTelegramPermissionPromptPort,
  createTelegramTodoDisplayPort,
  DEFAULT_IMAGE_PROMPT,
  downloadTelegramMessageImage,
  getTelegramBotToken,
  ImageTooLargeError,
  isBotCommand,
  parseTelegramUserTurn,
  prepareTelegramImages,
  recordTelegramMessage,
  replyError,
  replyWithModelText,
  startTelegramBot,
  startTelegramTypingIndicator,
  type TelegramContext,
  UnsupportedImageError,
  withTurnMutex,
} from "./src/telegram/mod.ts";

const PENDING_INTERACTION_HINT =
  "Please resolve the pending Telegram approval or broker permission prompt first (or wait for it to time out).";

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

function isImageInputError(error: unknown): boolean {
  return error instanceof ImageTooLargeError || error instanceof UnsupportedImageError;
}

async function main(): Promise<void> {
  if (Deno.env.get("DENO_PERMISSION_BROKER_PATH")) {
    assertPermissionBrokerSupported();
  }

  const controller = new AbortController();
  const { maxContextLength } = getEnv();
  const botToken = getTelegramBotToken();

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

  function abortActiveTurn(): boolean {
    permissionPrompts.abortPending();
    approvals.abortPending();
    const aborted = activeTurns.abortActiveTurn();
    if (aborted) {
      console.log("Turn aborted (act, approvals, and broker prompts cancelled).");
    }
    return aborted;
  }

  const turnAbort = { abortActiveTurn };

  async function executeTelegramTurn(
    ctx: TelegramContext,
    input: UserTurnInput,
    replyToMessageId: number,
    updateId: number,
  ): Promise<number> {
    const normalized = normalizeUserTurnInput(input);
    const imageCount = normalized.images?.length ?? 0;
    const message = ctx.message;
    if (!message) return 0;

    const stopTyping = startTelegramTypingIndicator({
      api: ctx.api,
      chatId: ctx.chat!.id,
      threadId: message.message_thread_id,
      signal: controller.signal,
    });

    let actMs = 0;
    try {
      try {
        await ctx.reply("Working on it...", {
          message_thread_id: message.message_thread_id,
        });
      } catch {
        /* best-effort ack while the model turn runs */
      }

      await withTurnMutex(async () => {
        const toolsList = await createTurnTools();
        activeTurnId = String(updateId);

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
        approvals.setTurnContext({ ctx, signal: turnController.signal });
        const actStarted = performance.now();
        try {
          console.log(`Model turn started${imageCount > 0 ? ` (${imageCount} image(s))` : ""}.`);
          const { replyTexts, compacted } = await runTurn(agent, normalized, {
            tools: toolsList,
            signal: turnController.signal,
          });
          console.log(`Model turn finished (${replyTexts.length} reply chunk(s)).`);

          if (replyTexts.length > 0) {
            await replyWithModelText(ctx, replyTexts, replyToMessageId, message.message_thread_id);
          } else {
            await ctx.reply("The model finished without a reply. Try again or rephrase.", {
              message_thread_id: message.message_thread_id,
            });
          }

          if (compacted) {
            logDebug("session.compacted", { sessionId: agent.session.id });
          }
        } finally {
          actMs = performance.now() - actStarted;
          clearActiveTurn();
          controller.signal.removeEventListener("abort", onShutdown);
          approvalController.abort();
          permissionPrompts.abortPending();
          approvals.abortPending();
          userQuestions.clearTurnContext();
          permissionPrompts.clearTurnContext();
          todoDisplay.clearTurnContext();
          approvals.clearTurnContext();
          activeTurnId = "no-active-turn";
        }
      });
    } finally {
      stopTyping();
    }
    return actMs;
  }

  const telegram = createTelegramManager({
    session: agent.session,
    onAdminStart: async (ctx) => {
      const bootstrap = await readBootstrapIfPresent(workspace.path);
      if (bootstrap && ctx.message) {
        logDebug("bootstrap.start", { sessionId: agent.session.id, length: bootstrap.length });
        await executeTelegramTurn(
          ctx,
          { text: bootstrap },
          ctx.message.message_id,
          ctx.update.update_id,
        );
        return;
      }
      await ctx.reply(`Hello, admin!\n\n${SESSION_HELP}`);
    },
    userQuestions,
    permissionPrompts,
    approvals,
    turnAbort,
    todosDir: workspace.todosDir,
    updateTelegramMeta: bindUpdateTelegramMeta,
  });

  let telegramRunner: ReturnType<typeof startTelegramBot> | undefined;

  const mediaGroupBuffer = createMediaGroupBuffer(async (payload) => {
    let outcome: "error" | "ok" = "ok";
    let actMs = 0;
    try {
      if (payload.items.length === 0) return;

      await traceSpan(
        "telegram.album.flush",
        async (span) => {
          span.setAttributes({
            "telegram.media_group_id": payload.mediaGroupId,
            "telegram.album.size": payload.items.length,
            "telegram.has_images": true,
            "telegram.image_count": payload.items.length,
            "session.id": agent.session.id,
          });

          const images = await prepareTelegramImages(lmstudio.client, payload.items);
          const input: UserTurnInput = {
            text: payload.text ?? DEFAULT_IMAGE_PROMPT,
            images,
          };

          console.log(
            `Telegram album flush (${payload.items.length} image(s), media_group_id=${payload.mediaGroupId}).`,
          );

          actMs = await executeTelegramTurn(
            payload.turnCtx,
            input,
            payload.context.replyToMessageId,
            payload.turnCtx.update.update_id,
          );
        },
        { root: true },
      );
    } catch (error) {
      outcome = "error";
      const ctx = payload.turnCtx;
      if (isImageInputError(error) && ctx.message) {
        const text = error instanceof Error ? error.message : String(error);
        await ctx.reply(text, { message_thread_id: ctx.message.message_thread_id });
        return;
      }
      logDebug("telegram.album.error", {
        message: error instanceof Error ? error.message : String(error),
      });
      console.error(error);
      if (ctx.message) {
        await replyError(ctx, ctx.message.message_thread_id);
      }
    } finally {
      recordTelegramMessage(outcome, false);
      recordActDuration(actMs, outcome);
    }
  });

  registerShutdown(controller, async () => {
    mediaGroupBuffer.dispose();
    await telegramRunner?.stop();
    await telegram.bot.stop();
    await subagents.shutdown();
    subagentKv.close();
    workspace[Symbol.dispose]();
  });

  telegram.bot.on("message", async (ctx: TelegramContext) => {
    if (ctx.message && isBotCommand(ctx.message) && botCommandName(ctx.message) === "q") {
      const aborted = abortActiveTurn();
      await ctx.reply(aborted ? "Aborted current turn." : "No active turn.", {
        message_thread_id: ctx.message.message_thread_id,
      });
      return;
    }

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
    let recordMetrics = true;

    try {
      await traceSpan(
        "telegram.message",
        async (span) => {
          const message = ctx.message;
          if (!message || !ctx.chat) {
            skipped = true;
            span.setAttribute("skipped", true);
            span.setAttribute("skip.reason", "non_actionable");
            return;
          }

          if (isBotCommand(message)) {
            skipped = true;
            span.setAttribute("skipped", true);
            span.setAttribute("skip.reason", "bot_command");
            return;
          }

          const mediaGroupId = message.media_group_id;
          if (mediaGroupId) {
            recordMetrics = false;
            const item = await downloadTelegramMessageImage(ctx.api, botToken, message);
            mediaGroupBuffer.enqueue({
              mediaGroupId,
              turnCtx: ctx,
              context: {
                chatId: ctx.chat.id,
                threadId: message.message_thread_id,
                replyToMessageId: message.message_id,
              },
              item,
              caption: message.caption,
            });
            span.setAttributes({
              "telegram.media_group_id": mediaGroupId,
              "telegram.has_images": true,
            });
            logDebug("telegram.album.enqueue", { mediaGroupId });
            return;
          }

          if (message.text?.trim()) {
            mediaGroupBuffer.flushPendingForChat(ctx.chat.id);
          }

          let userInput: UserTurnInput | null;
          try {
            userInput = await parseTelegramUserTurn(ctx, lmstudio.client, botToken);
          } catch (error) {
            if (isImageInputError(error)) {
              const text = error instanceof Error ? error.message : String(error);
              await ctx.reply(text, { message_thread_id: message.message_thread_id });
              return;
            }
            throw error;
          }

          if (!userInput) {
            skipped = true;
            span.setAttribute("skipped", true);
            span.setAttribute("skip.reason", "non_actionable");
            return;
          }

          const imageCount = userInput.images?.length ?? 0;
          span.setAttributes({
            "telegram.update_id": ctx.update.update_id,
            "message.length": userInput.text.length,
            "session.id": agent.session.id,
            ...(imageCount > 0 ? { "telegram.has_images": true, "telegram.image_count": imageCount } : {}),
          });

          logDebug("telegram.message.received", {
            updateId: String(ctx.update.update_id),
            length: String(userInput.text.length),
            ...(imageCount > 0 ? { imageCount: String(imageCount) } : {}),
          });
          console.log(
            `Telegram message received (${userInput.text.length} chars${
              imageCount > 0 ? `, ${imageCount} image(s)` : ""
            }).`,
          );

          actMs = await executeTelegramTurn(ctx, userInput, message.message_id, ctx.update.update_id);
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
      if (isImageInputError(error) && ctx.message) {
        const text = error instanceof Error ? error.message : String(error);
        await ctx.reply(text, { message_thread_id: ctx.message.message_thread_id });
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
      if (recordMetrics) {
        recordTelegramMessage(outcome, skipped);
        recordActDuration(actMs, outcome);
      }
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
