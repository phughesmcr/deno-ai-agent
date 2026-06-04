import type { Tool } from "@lmstudio/sdk";

import {
  createAgent,
  createLMStudioManager,
  createSkillManager,
  createToolContext,
  createWorkspace,
  getModelToolSet,
  McpRegistry,
  normalizeUserTurnInput,
  readBootstrapIfPresent,
  recordActDuration,
  runTurn,
  setMcpSystemPromptAppendix,
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
import { loadAppConfig, logDebug, logError, logInfo, traceSpan } from "./src/shared/mod.ts";
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

function registerShutdown(controller: AbortController, stop: () => Promise<void>): void {
  const shutdown = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    void stop().finally(() => Deno.exit(0));
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
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
  const config = loadAppConfig();
  if (config.DENO_PERMISSION_BROKER_PATH) {
    assertPermissionBrokerSupported();
  }

  const controller = new AbortController();
  const maxContextLength = config.CONTEXT_LENGTH;
  const botToken = getTelegramBotToken();

  const userQuestions = createTelegramAskUserQuestionPort();
  const permissionPrompts = createTelegramPermissionPromptPort(config.PERMISSION_PROMPT_TIMEOUT_MS);
  const approvals = createTelegramApprovalGate();

  if (shouldRunPermissionControlClient()) {
    const controlPath = config.SILAS_PERMISSION_CONTROL_PATH!;
    const brokerPath = config.DENO_PERMISSION_BROKER_PATH ?? "";
    logInfo(`Silas connecting to permission broker\n  broker:  ${brokerPath}\n  control: ${controlPath}`);
    void runPermissionControlClient({ controlPath, promptPort: permissionPrompts }, controller.signal);
    await waitForPermissionControlClient();
    logInfo("Permission broker control channel registered.");
  }

  const workspace = await createWorkspace(new URL(".", import.meta.url));
  logInfo("Loading LM Studio model...");
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });
  logInfo(`LM Studio model loaded (${config.MODEL}).`);
  const agent = await createAgent({ workspace, lmstudio, maxContextLength, signal: controller.signal });
  logInfo("Agent session ready.");

  const mcpRegistry = new McpRegistry({
    workspacePath: workspace.path,
    userInteraction: userQuestions,
    elicitationEnabled: true,
  });
  logInfo("Connecting MCP servers...");
  await mcpRegistry.connectAll();
  if (mcpRegistry.connectionErrors.length > 0) {
    logInfo(`MCP registry ready with ${mcpRegistry.connectionErrors.length} connection error(s).`);
  } else {
    logInfo("MCP registry ready.");
  }
  if (mcpRegistry.connectionErrors.length > 0) {
    for (const err of mcpRegistry.connectionErrors) {
      logError("mcp.connection_error", { serverId: err.serverId, message: err.message });
    }
  }
  setMcpSystemPromptAppendix(mcpRegistry.systemPromptAppendix);
  await agent.sessions.applySystemPrompt(await workspace.reloadSystemPrompt());

  const subagentKv = await Deno.openKv(":memory:");

  const bindUpdateTelegramMeta = (sessionId: string, meta: Parameters<typeof updateTelegramMeta>[2]) =>
    updateTelegramMeta(workspace.todosDir, sessionId, meta);
  const todoDisplay = createTelegramTodoDisplayPort({ updateTelegramMeta: bindUpdateTelegramMeta });
  let activeTurnId = "no-active-turn";
  const activeTurns = new ActiveTurnRegistry();
  const toolContext = await createToolContext(workspace.path, {
    sessionId: () => agent.sessions.current.id,
    turnId: () => activeTurnId,
    signal: () => activeTurns.actSignal ?? controller.signal,
  });
  const skills = await createSkillManager({ root: workspace.path });
  const subagents = new SubagentManager({
    kv: subagentKv,
    model: lmstudio.model,
    workspace: toolContext,
    skills,
    getSessionId: () => agent.sessions.current.id,
  });
  const createTurnToolSet = async (): Promise<
    { tools: Tool[]; guardToolCall: ReturnType<typeof getModelToolSet>["guardToolCall"] }
  > => {
    await skills.refresh();
    await mcpRegistry.refreshTools();
    setMcpSystemPromptAppendix(mcpRegistry.systemPromptAppendix);
    return getModelToolSet({
      workspace: toolContext,
      approvalGate: approvals,
      userQuestions,
      todos: {
        getSessionId: () => agent.sessions.current.id,
        todosDir: workspace.todosDir,
        display: todoDisplay,
        updateTelegramMeta: bindUpdateTelegramMeta,
      },
      skills: {
        manager: skills,
        getSessionId: () => agent.sessions.current.id,
      },
      subagents,
      mcp: mcpRegistry,
    });
  };

  function abortActiveTurn(): boolean {
    const hadPendingInteraction = permissionPrompts.isPending() || approvals.isPending();
    permissionPrompts.abortPending();
    approvals.abortPending();
    const aborted = activeTurns.abortActiveTurn();
    if (aborted || hadPendingInteraction) {
      logInfo("Turn aborted (act, approvals, and broker prompts cancelled).");
    }
    return aborted || hadPendingInteraction;
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
        const { tools, guardToolCall } = await createTurnToolSet();
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
        approvals.setTurnContext({ ctx, signal: approvalController.signal });
        const actStarted = performance.now();
        let completed = false;
        try {
          logInfo(`Model turn started${imageCount > 0 ? ` (${imageCount} image(s))` : ""}.`);
          const { replyTexts, compacted } = await runTurn(agent, normalized, {
            tools,
            guardToolCall,
            signal: turnController.signal,
          });
          logInfo(`Model turn finished (${replyTexts.length} reply chunk(s)).`);

          if (replyTexts.length > 0) {
            await replyWithModelText(ctx, replyTexts, replyToMessageId, message.message_thread_id);
          } else {
            await ctx.reply("The model finished without a reply. Try again or rephrase.", {
              message_thread_id: message.message_thread_id,
            });
          }

          if (compacted) {
            logDebug("session.compacted", { sessionId: agent.sessions.current.id });
          }
          completed = true;
        } finally {
          actMs = performance.now() - actStarted;
          clearActiveTurn();
          controller.signal.removeEventListener("abort", onShutdown);
          if (!completed) {
            approvalController.abort();
            permissionPrompts.abortPending();
            approvals.abortPending();
          }
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
    session: agent.sessions,
    onAdminStart: async (ctx) => {
      const bootstrap = await readBootstrapIfPresent(workspace.path);
      if (bootstrap && ctx.message) {
        logDebug("bootstrap.start", { sessionId: agent.sessions.current.id, length: bootstrap.length });
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
            "session.id": agent.sessions.current.id,
          });

          const images = await prepareTelegramImages(lmstudio.client, payload.items);
          const input: UserTurnInput = {
            text: payload.text ?? DEFAULT_IMAGE_PROMPT,
            images,
          };

          logInfo(
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
      logError("telegram.album.exception", { message: error instanceof Error ? error.message : String(error) });
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
    await mcpRegistry.closeAll();
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
            "session.id": agent.sessions.current.id,
            ...(imageCount > 0 ? { "telegram.has_images": true, "telegram.image_count": imageCount } : {}),
          });

          logDebug("telegram.message.received", {
            updateId: String(ctx.update.update_id),
            length: String(userInput.text.length),
            ...(imageCount > 0 ? { imageCount: String(imageCount) } : {}),
          });
          logInfo(
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
      if (isAbortError(error)) {
        outcome = "ok";
        if (ctx.message) {
          await ctx.reply("Turn aborted.", { message_thread_id: ctx.message.message_thread_id });
        }
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
      logError("telegram.message.exception", { message: error instanceof Error ? error.message : String(error) });
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
    logInfo("Silas ready - listening on Telegram.");
    await telegramRunner.task();
  }, { root: true });
}

if (import.meta.main) {
  void main();
}
