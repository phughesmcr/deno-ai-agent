import type { Tool } from "@lmstudio/sdk";

import {
  createCronPermissionPromptPort,
  CronCommandManager,
  CronDispatcher,
  type CronJob,
  CronJobStore,
} from "./src/cron/mod.ts";
import { setCronDispatcher } from "./src/cron/runtime.ts";
import {
  createAgent,
  createLMStudioManager,
  createNoopTodoDisplayPort,
  createSkillManager,
  createToolContext,
  createUnavailableAskUserQuestionPort,
  createWorkspace,
  DenoKvTodoStore,
  getModelToolSet,
  McpRegistry,
  normalizeUserTurnInput,
  readBootstrapIfPresent,
  recordActDuration,
  runTurn,
  setMcpSystemPromptAppendix,
  SubagentJobService,
  type UserTurnInput,
} from "./src/agent/mod.ts";
import {
  assertPermissionBrokerSupported,
  runPermissionControlClient,
  shouldRunPermissionControlClient,
  waitForPermissionControlClient,
} from "./src/permission-broker/mod.ts";
import { type ApprovalGate, loadAppConfig, logDebug, logError, logInfo, traceSpan } from "./src/shared/mod.ts";
import {
  ActiveTurnRegistry,
  AudioTooLargeError,
  botCommandName,
  createMediaGroupBuffer,
  createTelegramApprovalGate,
  createTelegramAskUserQuestionPort,
  createTelegramManager,
  createTelegramPermissionPromptPort,
  createTelegramTodoDisplayPort,
  createWhisperCliTranscriber,
  DEFAULT_IMAGE_PROMPT,
  downloadTelegramMessageImage,
  getTelegramBotToken,
  ImageTooLargeError,
  type InlineKeyboardMarkup,
  isBotCommand,
  parseTelegramUserTurn,
  prepareTelegramImages,
  recordTelegramMessage,
  replyError,
  replyWithModelText,
  startTelegramBot,
  startTelegramTypingIndicator,
  telegramAudioDuration,
  telegramAudioKind,
  type TelegramContext,
  type TelegramConversationRef,
  telegramConversationRef,
  TelegramSessionBindingStore,
  TelegramSessionCoordinator,
  UnsupportedAudioError,
  UnsupportedImageError,
} from "./src/telegram/mod.ts";
import { sendModelTextReply } from "./src/telegram/model-reply.ts";

const PENDING_INTERACTION_HINT =
  "Please resolve the pending Telegram approval or broker permission prompt first (or wait for it to time out).";

function registerShutdown(runShutdown: () => Promise<void>): void {
  const onShutdownSignal = (): void => {
    void runShutdown();
  };
  Deno.addSignalListener("SIGINT", onShutdownSignal);
  Deno.addSignalListener("SIGTERM", onShutdownSignal);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

function isImageInputError(error: unknown): boolean {
  return error instanceof ImageTooLargeError || error instanceof UnsupportedImageError;
}

function isAudioInputError(error: unknown): boolean {
  return error instanceof AudioTooLargeError || error instanceof UnsupportedAudioError;
}

async function main(): Promise<void> {
  const config = loadAppConfig();
  if (config.DENO_PERMISSION_BROKER_PATH) {
    assertPermissionBrokerSupported();
  }

  const controller = new AbortController();
  const maxContextLength = config.CONTEXT_LENGTH;
  const botToken = getTelegramBotToken();
  const audioTranscriber = config.TELEGRAM_AUDIO_TRANSCRIPTION && config.WHISPER_CPP_BIN && config.WHISPER_CPP_MODEL ?
    createWhisperCliTranscriber({
      bin: config.WHISPER_CPP_BIN,
      model: config.WHISPER_CPP_MODEL,
      language: config.WHISPER_CPP_LANGUAGE,
    }) :
    undefined;

  const userQuestions = createTelegramAskUserQuestionPort();
  const permissionPrompts = createCronPermissionPromptPort(
    createTelegramPermissionPromptPort(config.PERMISSION_PROMPT_TIMEOUT_MS),
  );
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
  const workspaceKv = await Deno.openKv(workspace.kvPath);
  logInfo("Loading LM Studio model...");
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });
  logInfo(`LM Studio model loaded (${config.MODEL}).`);
  const agent = await createAgent({
    workspace,
    kv: workspaceKv,
    lmstudio,
    maxContextLength,
    signal: controller.signal,
  });
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

  const telegramSessions = new TelegramSessionCoordinator({
    sessions: agent.sessions,
    bindings: new TelegramSessionBindingStore(workspaceKv),
  });
  const cronStore = new CronJobStore(workspaceKv);

  const todoStore = new DenoKvTodoStore(workspaceKv);
  const todoDisplay = createTelegramTodoDisplayPort({ store: todoStore });
  let activeTurnId = "no-active-turn";
  const activeTurns = new ActiveTurnRegistry();
  const toolContext = await createToolContext(workspace.path, {
    sessionId: () => agent.sessions.current.id,
    turnId: () => activeTurnId,
    signal: () => activeTurns.actSignal ?? controller.signal,
  });
  const skills = await createSkillManager({ root: workspace.path });
  const subagents = new SubagentJobService({
    kv: workspaceKv,
    model: agent.modelAct,
    workspace: toolContext,
    skills,
    getSessionId: () => agent.sessions.current.id,
  });
  await subagents.reconcileAbandonedOnStartup();
  const createTurnToolSet = async (overrides?: {
    approvalGate?: ApprovalGate;
    userQuestions?: typeof userQuestions;
    todoDisplay?: ReturnType<typeof createNoopTodoDisplayPort>;
  }): Promise<
    { tools: Tool[]; guardToolCall: ReturnType<typeof getModelToolSet>["guardToolCall"] }
  > => {
    await skills.refresh();
    await mcpRegistry.refreshTools();
    setMcpSystemPromptAppendix(mcpRegistry.systemPromptAppendix);
    return getModelToolSet({
      workspace: toolContext,
      approvalGate: overrides?.approvalGate ?? approvals,
      userQuestions: overrides?.userQuestions ?? userQuestions,
      todos: {
        getSessionId: () => agent.sessions.current.id,
        store: todoStore,
        display: overrides?.todoDisplay ?? todoDisplay,
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

  async function executeCronTurn(
    job: CronJob,
    approvalGate: ApprovalGate,
    signal: AbortSignal,
  ): Promise<void> {
    const ref: TelegramConversationRef = {
      chatId: job.chatId,
      ...(job.threadId !== undefined ? { threadId: job.threadId } : {}),
    };
    const startMessage = await telegram.bot.api.sendMessage(
      job.chatId,
      `Cron job ${job.id} started.\n${job.prompt}`,
      { message_thread_id: job.threadId },
    );
    const cronTurnContext = {
      config: { adminId: config.TELEGRAM_ADMIN_ID, isAdmin: true },
      message: {
        chat: { id: job.chatId },
        message_thread_id: job.threadId,
      },
      reply: (text: string, options?: { reply_markup?: InlineKeyboardMarkup; message_thread_id?: number }) =>
        telegram.bot.api.sendMessage(job.chatId, text, {
          message_thread_id: options?.message_thread_id ?? job.threadId,
          ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {}),
        }),
    };

    let actMs = 0;
    if (job.sessionMode === "fresh") {
      await telegramSessions.replaceWithNew(ref, { topicName: job.topicName });
    }
    await telegramSessions.withConversation(ref, async () => {
      const { tools, guardToolCall } = await createTurnToolSet({
        approvalGate,
        userQuestions: createUnavailableAskUserQuestionPort(),
        todoDisplay: createNoopTodoDisplayPort(),
      });
      activeTurnId = `cron:${job.id}`;

      const turnController = new AbortController();
      const approvalController = new AbortController();
      const onShutdown = (): void => {
        turnController.abort();
        approvalController.abort();
      };
      signal.addEventListener("abort", onShutdown);
      const clearActiveTurn = activeTurns.setActiveTurn({
        id: activeTurnId,
        actController: turnController,
        approvalController,
      });

      const runSignal = AbortSignal.any([signal, turnController.signal]);
      permissionPrompts.setTurnContext({ ctx: cronTurnContext, signal: approvalController.signal });
      approvals.setTurnContext({ ctx: cronTurnContext, signal: approvalController.signal });
      const actStarted = performance.now();
      try {
        const { replyTexts } = await runTurn(agent, { text: job.prompt }, {
          tools,
          guardToolCall,
          signal: runSignal,
        });
        if (replyTexts.length > 0) {
          await sendModelTextReply(
            {
              reply: (text, options) => telegram.bot.api.sendMessage(job.chatId, text, options),
            },
            replyTexts,
            startMessage.message_id,
            job.threadId,
          );
        } else {
          await telegram.bot.api.sendMessage(
            job.chatId,
            "Cron job finished without a reply.",
            { message_thread_id: job.threadId },
          );
        }
      } finally {
        actMs = performance.now() - actStarted;
        clearActiveTurn();
        signal.removeEventListener("abort", onShutdown);
        approvalController.abort();
        permissionPrompts.clearTurnContext();
        approvals.clearTurnContext();
        activeTurnId = "no-active-turn";
      }
    }, { topicName: job.topicName });
    recordActDuration(actMs, "ok");
  }

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

      const ref = telegramConversationRef(ctx);
      if (!ref) throw new Error("No Telegram conversation ref for model turn");

      await telegramSessions.withConversation(ref, async () => {
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
    sessions: telegramSessions,
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
    },
    userQuestions,
    permissionPrompts,
    approvals,
    turnAbort,
    todoStore,
    cronForConversation: (ref, topics) =>
      new CronCommandManager({
        store: cronStore,
        ref,
        mcpTools: () => mcpRegistry.getTools(),
        scheduleExtractor: agent.modelAct,
        userInteraction: userQuestions,
        createTopic: topics.createTopic,
      }),
  });

  setCronDispatcher(
    new CronDispatcher({
      store: cronStore,
      permissionPrompts,
      approvals,
      signal: controller.signal,
      runner: {
        run: executeCronTurn,
      },
    }),
  );

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
            "telegram.chat_id": payload.context.chatId,
            ...(payload.context.threadId !== undefined ? { "telegram.thread_id": payload.context.threadId } : {}),
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

  let intentionalShutdown = false;
  let cleanupPromise: Promise<void> | undefined;

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function cleanupStep(name: string, step: () => void | Promise<void>): Promise<void> {
    try {
      await Promise.try(step);
    } catch (error) {
      logError("shutdown.cleanup_error", { step: name, message: errorMessage(error) });
    }
  }

  function cleanup(): Promise<void> {
    cleanupPromise ??= (async () => {
      await cleanupStep("telegram.media_group_buffer.dispose", () => mediaGroupBuffer.dispose());
      await cleanupStep("mcp.close_all", () => mcpRegistry.closeAll());
      await cleanupStep("telegram.runner.stop", async () => {
        if (telegramRunner?.isRunning()) await telegramRunner.stop();
      });
      await cleanupStep("telegram.bot.stop", () => telegram.bot.stop());
      await cleanupStep("subagents.shutdown", () => subagents.shutdown());
      await cleanupStep("workspace.kv.close", () => workspaceKv.close());
      await cleanupStep("workspace.dispose", () => workspace[Symbol.dispose]());
    })();
    return cleanupPromise;
  }

  async function shutdownFromSignal(): Promise<void> {
    if (intentionalShutdown) return;
    intentionalShutdown = true;
    controller.abort();
    await cleanup();
    Deno.exit(0);
  }

  registerShutdown(shutdownFromSignal);

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
            mediaGroupBuffer.flushPendingForConversation({
              chatId: ctx.chat.id,
              ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
            });
          }

          let userInput: UserTurnInput | null;
          try {
            userInput = await parseTelegramUserTurn(ctx, lmstudio.client, botToken, audioTranscriber);
          } catch (error) {
            if (isImageInputError(error) || isAudioInputError(error)) {
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
          const audioKind = telegramAudioKind(message);
          const audioDuration = telegramAudioDuration(message);
          span.setAttributes({
            "telegram.update_id": ctx.update.update_id,
            "message.length": userInput.text.length,
            "telegram.chat_id": ctx.chat.id,
            ...(message.message_thread_id !== undefined ? { "telegram.thread_id": message.message_thread_id } : {}),
            ...(imageCount > 0 ? { "telegram.has_images": true, "telegram.image_count": imageCount } : {}),
            ...(audioKind ? { "telegram.has_audio": true, "telegram.audio_kind": audioKind } : {}),
            ...(audioDuration !== undefined ? { "telegram.audio_duration": audioDuration } : {}),
          });

          logDebug("telegram.message.received", {
            updateId: String(ctx.update.update_id),
            length: String(userInput.text.length),
            ...(imageCount > 0 ? { imageCount: String(imageCount) } : {}),
            ...(audioKind ? { audioKind } : {}),
          });
          logInfo(
            `Telegram message received (${userInput.text.length} chars${
              imageCount > 0 ? `, ${imageCount} image(s)` : ""
            }${audioKind ? `, ${audioKind} audio` : ""}).`,
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
      if ((isImageInputError(error) || isAudioInputError(error)) && ctx.message) {
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

  let runnerError: unknown;
  await traceSpan("telegram.bot.start", async () => {
    telegramRunner = startTelegramBot(telegram.bot);
    logInfo("Silas ready - listening on Telegram.");
    const runnerTask = telegramRunner.task();
    if (!runnerTask) return;
    try {
      await runnerTask;
    } catch (error) {
      runnerError = error;
    }
  }, { root: true });

  if (!intentionalShutdown) {
    logError("telegram.runner.stopped_unexpectedly", {
      message: runnerError ? errorMessage(runnerError) : "Telegram runner task resolved without shutdown request.",
    });
    controller.abort();
    await cleanup();
    Deno.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
