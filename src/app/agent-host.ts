import type { Tool } from "@lmstudio/sdk";

import { createCronCapabilityDelegate, CronCommandManager, CronDispatcher, CronJobStore } from "../cron/mod.ts";
import { setCronDispatcher } from "../cron/runtime.ts";
import {
  createAgent,
  createLMStudioManager,
  createModelActObserver,
  createNoopTodoDisplayPort,
  createSkillManager,
  createToolContext,
  createUnavailableUserInteractionPort,
  createWorkspace,
  DenoKvTodoStore,
  getModelToolSet,
  McpRegistry,
  readBootstrapIfPresent,
  recordActDuration,
  setMcpSystemPromptAppendix,
  SubagentRuntime,
  tokenBucket,
  userTurnImageCount,
  type UserTurnInput,
} from "../agent/mod.ts";
import {
  assertPermissionBrokerSupported,
  runPermissionControlClient,
  shouldRunPermissionControlClient,
  waitForPermissionControlClient,
  withBrokerGrantScope,
} from "../permission-broker/mod.ts";
import {
  CapabilityDecisionService,
  CapabilityLedger,
  createDurableUserInteractionPort,
  createQueueWorker,
  EgressOutbox,
  KvEventStore,
  KvWorkQueue,
  type LeasedWorkItem,
  QueuedTurnProcessor,
  WorkspaceGate,
} from "../core/mod.ts";
import { errorMessage, loadAppConfig, logDebug, logError, logInfo, traceSpan } from "../shared/mod.ts";
import {
  ActiveTurnRegistry,
  AudioTooLargeError,
  botCommandName,
  createMediaGroupBuffer,
  createTelegramCapabilityPromptPort,
  createTelegramManager,
  createTelegramTodoDisplayPort,
  createTelegramUserInteractionPort,
  createWhisperCliTranscriber,
  DEFAULT_IMAGE_PROMPT,
  downloadTelegramMessageImage,
  durableTelegramImages,
  getTelegramBotToken,
  ImageTooLargeError,
  isBotCommand,
  parseTelegramUserTurn,
  prepareDurableUserImages,
  recordTelegramMessage,
  replyError,
  startTelegramBot,
  startTelegramTypingIndicator,
  telegramAudioDuration,
  telegramAudioKind,
  type TelegramContext,
  TelegramSessionBindingStore,
  TelegramSessionCoordinator,
  UnsupportedAudioError,
  UnsupportedImageError,
} from "../telegram/mod.ts";
import { completeCronRunSchedule, failCronRunSchedule } from "./cron-work.ts";
import { createBrokerCapabilityPromptPort } from "./broker-capability-prompt.ts";
import { QueuedImageStore } from "./image-store.ts";
import { runQueuedMaintenanceWork } from "./maintenance-work.ts";
import { createTelegramTurnEgressPort, runQueuedPreparedTurn } from "./queued-turn-runner.ts";
import { runStartupRecovery } from "./startup-recovery.ts";
import { queueAndSendTelegramEgress } from "./telegram-egress.ts";
import { type SubmitTelegramUserTurnRequest, TelegramWorkIntake } from "./telegram-work-intake.ts";
import {
  cronRunWorkPayload,
  prepareQueuedModelMessage,
  type UserTurnWorkPayload,
  userTurnWorkPayload,
} from "./work-payload.ts";

const PENDING_INTERACTION_HINT =
  "Please resolve the pending Telegram question or capability prompt first (or wait for it to time out).";
const MAX_INTERRUPTED_WORK_ATTEMPTS = 3;

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

/** Runs the Telegram-backed Silas agent host until shutdown. */
export async function runAgentHost(): Promise<void> {
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

  const telegramUserQuestions = createTelegramUserInteractionPort();
  const capabilityPrompts = createTelegramCapabilityPromptPort(config.PERMISSION_PROMPT_TIMEOUT_MS);

  const workspace = await createWorkspace(new URL("../../", import.meta.url));
  const workspaceKv = await Deno.openKv(workspace.kvPath);
  const coreEvents = new KvEventStore(workspaceKv);
  const egressOutbox = new EgressOutbox(coreEvents);
  const capabilityLedger = new CapabilityLedger({ kv: workspaceKv, events: coreEvents });
  const capabilityDecisions = new CapabilityDecisionService({ ledger: capabilityLedger, events: coreEvents });
  const workQueue = new KvWorkQueue({ kv: workspaceKv, events: coreEvents });
  const imageStore = new QueuedImageStore(workspaceKv);
  const workspaceGate = new WorkspaceGate();
  const workerOwnerId = `agent-host:${crypto.randomUUID()}`;
  logInfo("Loading LM Studio model...");
  const lmstudio = await createLMStudioManager({ signal: controller.signal, maxContextLength });
  logInfo(`LM Studio model loaded (${config.MODEL}).`);
  const agent = await createAgent({
    workspace,
    kv: workspaceKv,
    events: coreEvents,
    lmstudio,
    maxContextLength,
    signal: controller.signal,
  });
  logInfo("Agent session ready.");
  let activeTurnId = "no-active-turn";
  const userQuestions = createDurableUserInteractionPort({
    events: coreEvents,
    delegate: telegramUserQuestions,
    getSessionId: () => agent.sessions.current.id,
    getWorkId: () => activeTurnId === "no-active-turn" ? undefined : activeTurnId,
  });
  const cronCapabilities = createCronCapabilityDelegate(capabilityPrompts);
  const brokerPermissionPrompts = createBrokerCapabilityPromptPort({
    authorizer: {
      decide: (request, signal) => capabilityDecisions.decide(request, cronCapabilities, signal),
    },
    getSessionId: () => agent.sessions.current.id,
    getWorkId: () => activeTurnId === "no-active-turn" ? undefined : activeTurnId,
    timeoutMs: config.PERMISSION_PROMPT_TIMEOUT_MS,
  });

  if (shouldRunPermissionControlClient()) {
    const controlPath = config.SILAS_PERMISSION_CONTROL_PATH!;
    const brokerPath = config.DENO_PERMISSION_BROKER_PATH ?? "";
    logInfo(`Silas connecting to permission broker\n  broker:  ${brokerPath}\n  control: ${controlPath}`);
    void runPermissionControlClient({ controlPath, promptPort: brokerPermissionPrompts }, controller.signal);
    await waitForPermissionControlClient();
    logInfo("Permission broker control channel registered.");
  }

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
  let appliedRuntimeSystemPrompt = await workspace.reloadSystemPrompt();
  await agent.sessions.applySystemPrompt(appliedRuntimeSystemPrompt);

  const telegramSessions = new TelegramSessionCoordinator({
    sessions: agent.sessions,
    bindings: new TelegramSessionBindingStore(workspaceKv),
  });
  const cronStore = new CronJobStore(workspaceKv);

  const todoStore = new DenoKvTodoStore(workspaceKv);
  const todoDisplay = createTelegramTodoDisplayPort({ store: todoStore });
  const activeTurns = new ActiveTurnRegistry();
  const toolContext = await createToolContext(workspace.path, {
    sessionId: () => agent.sessions.current.id,
    turnId: () => activeTurnId,
    signal: () => activeTurns.actSignal ?? controller.signal,
  });
  const skills = await createSkillManager({ root: workspace.path });
  const subagents = new SubagentRuntime({
    kv: workspaceKv,
    events: coreEvents,
    queue: workQueue,
    model: agent.modelAct,
    workspace: toolContext,
    skills,
    getSessionId: () => agent.sessions.current.id,
    wakeQueue: () => queuedWorker.wake(),
  });
  const createTurnToolSet = async (overrides?: {
    userQuestions?: typeof userQuestions;
    todoDisplay?: ReturnType<typeof createNoopTodoDisplayPort>;
  }): Promise<
    { tools: Tool[]; guardToolCall: ReturnType<typeof getModelToolSet>["guardToolCall"] }
  > => {
    await skills.refresh();
    await mcpRegistry.refreshTools();
    setMcpSystemPromptAppendix(mcpRegistry.systemPromptAppendix);
    const runtimeSystemPrompt = workspace.systemPrompt;
    if (runtimeSystemPrompt !== appliedRuntimeSystemPrompt) {
      appliedRuntimeSystemPrompt = runtimeSystemPrompt;
      await agent.sessions.applySystemPrompt(runtimeSystemPrompt);
    }
    return getModelToolSet(
      {
        workspace: toolContext,
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
      },
      {
        decide: (request, signal) =>
          capabilityDecisions.decide(request, cronCapabilities, activeTurns.approvalSignal ?? signal),
      },
    );
  };

  function abortActiveTurn(): boolean {
    const hadPendingInteraction = capabilityPrompts.isPending();
    brokerPermissionPrompts.abortPending();
    capabilityPrompts.abortPending();
    const aborted = activeTurns.abortActiveTurn();
    if (aborted || hadPendingInteraction) {
      logInfo("Turn aborted (act and capability prompts cancelled).");
    }
    return aborted || hadPendingInteraction;
  }

  const telegramWorkIntake = new TelegramWorkIntake({
    queue: workQueue,
    events: coreEvents,
    egressOutbox,
    imageStore,
    capabilityLedger,
    cronStore,
    sessions: telegramSessions,
    telegramApi: {
      sendMessage: (chatId, text, options) => telegram.bot.api.sendMessage(chatId, text, options),
    },
    wakeQueue: () => queuedWorker.wake(),
    currentSessionId: () => agent.sessions.current.id,
  });

  function syntheticTelegramContext(target: UserTurnWorkPayload["telegram"]): TelegramContext {
    return {
      config: { adminId: config.TELEGRAM_ADMIN_ID, isAdmin: true },
      chat: { id: target.chatId },
      message: {
        chat: { id: target.chatId },
        message_id: target.replyToMessageId,
        message_thread_id: target.threadId,
      },
      api: telegram.bot.api,
      reply: (text: string, options?: Record<string, unknown>) =>
        telegram.bot.api.sendMessage(target.chatId, text, {
          ...options,
          message_thread_id: typeof options?.["message_thread_id"] === "number" ?
            options["message_thread_id"] :
            target.threadId,
        }),
    } as unknown as TelegramContext;
  }

  async function sendQueuedModelReply(
    work: LeasedWorkItem,
    payload: UserTurnWorkPayload,
    replyTexts: readonly string[],
    fallbackText: string,
  ): Promise<void> {
    await queueAndSendTelegramEgress({
      outbox: egressOutbox,
      api: {
        sendMessage: (chatId, text, options) => telegram.bot.api.sendMessage(chatId, text, options),
      },
      workId: work.id,
      sessionId: work.sessionId,
      target: payload.telegram,
      replies: replyTexts,
      ...(replyTexts.length === 0 ? { fallbackText } : {}),
    });
  }

  async function sendQueuedErrorReply(work: LeasedWorkItem, payload: UserTurnWorkPayload): Promise<void> {
    await sendQueuedModelReply(
      work,
      payload,
      [],
      "Something went wrong while handling your message. Please try again.",
    );
  }

  async function submitTelegramUserTurn(request: SubmitTelegramUserTurnRequest): Promise<number> {
    if (!request.ctx.chat || !request.ctx.message) return 0;
    const stopTyping = startTelegramTypingIndicator({
      api: request.ctx.api,
      chatId: request.ctx.chat.id,
      threadId: request.ctx.message.message_thread_id,
      signal: controller.signal,
    });
    try {
      await telegramWorkIntake.submitUserTurn(request);
    } finally {
      stopTyping();
    }
    return 0;
  }

  async function runQueuedUserTurn(work: LeasedWorkItem, signal: AbortSignal): Promise<void> {
    const payload = userTurnWorkPayload(work.payload);
    const liveCtx = telegramWorkIntake.liveContext(work.id);
    const ctx = liveCtx ?? syntheticTelegramContext(payload.telegram);
    const turnController = new AbortController();
    const approvalController = new AbortController();
    const onShutdown = (): void => {
      turnController.abort();
      approvalController.abort();
    };
    signal.addEventListener("abort", onShutdown);
    activeTurnId = work.id;
    const clearActiveTurn = activeTurns.setActiveTurn({
      id: activeTurnId,
      actController: turnController,
      approvalController,
    });

    const runSignal = AbortSignal.any([signal, turnController.signal]);
    const stopTyping = startTelegramTypingIndicator({
      api: telegram.bot.api,
      chatId: payload.telegram.chatId,
      threadId: payload.telegram.threadId,
      signal: runSignal,
    });
    if (liveCtx) userQuestions.setTurnContext({ ctx: liveCtx, signal: runSignal });
    capabilityPrompts.setTurnContext({ ctx, signal: approvalController.signal });
    todoDisplay.setTurnContext({ ctx, signal: runSignal });
    const actStarted = performance.now();
    let completed = false;
    let workSettled = false;
    let terminalWork = false;
    let delegatedToTurnRunner = false;
    try {
      await telegramSessions.withSession(work.sessionId, async () => {
        const { tools, guardToolCall } = await createTurnToolSet({
          ...(liveCtx ? {} : { userQuestions: createUnavailableUserInteractionPort() }),
        });
        logInfo("Queued Telegram work started.");
        const userMessage = await prepareQueuedModelMessage(
          payload.input,
          (images) => imageStore.loadImages(images),
          (images) => prepareDurableUserImages(lmstudio.client, images),
        );
        const result = await traceSpan(
          "lmstudio.act",
          async (actSpan) => {
            const observer = createModelActObserver();
            const imageCount = userTurnImageCount(userMessage);
            if (imageCount > 0) actSpan.setAttribute("user.images.count", imageCount);
            delegatedToTurnRunner = true;
            const turnResult = await runQueuedPreparedTurn({
              events: coreEvents,
              queue: workQueue,
              context: agent.context,
              egress: createTelegramTurnEgressPort({
                sendMessage: (chatId, text, options) => telegram.bot.api.sendMessage(chatId, text, options),
              }),
              baseSystemPrompt: workspace.systemPrompt,
              work,
              userMessage,
              tools,
              guardToolCall,
              observer,
              signal: runSignal,
              abortDisposition: () => signal.aborted ? "release" : "cancel",
              fallbackText: "The model finished without a reply. Try again or rephrase.",
            });
            const turnTokens = (await agent.modelAct.countTokens(turnResult.persistedMessages))
              .reduce((sum, count) => sum + count, 0);
            if (turnResult.finalization) {
              actSpan.setAttribute("context.tokens", tokenBucket(turnResult.finalization.totalTokens));
            }
            actSpan.setAttribute("turn.tokens", tokenBucket(turnTokens));
            actSpan.setAttribute("reply.count", turnResult.replyTexts.length);
            if (turnResult.firstTokenMs !== undefined) {
              actSpan.setAttribute("first_token.ms", Math.round(turnResult.firstTokenMs));
            }
            return turnResult;
          },
          { attributes: { "tools.count": tools.length } },
        );
        logInfo(`Queued Telegram work finished (${result.replyTexts.length} reply chunk(s)).`);
        if (result.finalization?.compacted) {
          logDebug("session.compacted", { sessionId: agent.sessions.current.id });
        }
        terminalWork = true;
        workSettled = true;
        completed = true;
      });
    } catch (error) {
      if (!workSettled) {
        if (delegatedToTurnRunner) {
          terminalWork = !(isAbortError(error) && signal.aborted);
        } else if (isAbortError(error) && turnController.signal.aborted && !signal.aborted) {
          await workQueue.cancel(work.id, { reason: "Turn aborted." });
          terminalWork = true;
        } else if (isAbortError(error) && signal.aborted) {
          await workQueue.release(work.id, { leaseId: work.lease.id });
        } else {
          await workQueue.fail(work.id, {
            leaseId: work.lease.id,
            reason: errorMessage(error),
          });
          terminalWork = true;
        }
        workSettled = true;
      }
      if (!isAbortError(error)) {
        try {
          await sendQueuedErrorReply(work, payload);
        } catch (sendError) {
          logError("telegram.queued_error_reply_failed", { message: errorMessage(sendError) });
        }
      }
      throw error;
    } finally {
      recordActDuration(performance.now() - actStarted, completed ? "ok" : "error");
      clearActiveTurn();
      signal.removeEventListener("abort", onShutdown);
      if (!completed) {
        approvalController.abort();
        brokerPermissionPrompts.abortPending();
        capabilityPrompts.abortPending();
      }
      if (liveCtx) userQuestions.clearTurnContext();
      stopTyping();
      if (terminalWork && payload.input.durableImages?.length) {
        try {
          await imageStore.deleteImages(payload.input.durableImages);
        } catch (error) {
          logError("telegram.queued_image_cleanup_failed", { message: errorMessage(error) });
        }
      }
      capabilityPrompts.clearTurnContext();
      todoDisplay.clearTurnContext();
      activeTurnId = "no-active-turn";
      telegramWorkIntake.deleteLiveContext(work.id);
    }
  }

  async function runQueuedCronTurn(work: LeasedWorkItem, signal: AbortSignal): Promise<void> {
    const payload = cronRunWorkPayload(work.payload);
    const job = await cronStore.get(payload.cron.jobId);
    if (!job) {
      await workQueue.fail(work.id, {
        leaseId: work.lease.id,
        reason: `Cron job not found: ${payload.cron.jobId}`,
      });
      throw new Error(`Cron job not found: ${payload.cron.jobId}`);
    }

    const ctx = syntheticTelegramContext(payload.telegram);
    const turnController = new AbortController();
    const approvalController = new AbortController();
    const onShutdown = (): void => {
      turnController.abort();
      approvalController.abort();
    };
    signal.addEventListener("abort", onShutdown);
    activeTurnId = work.id;
    const clearActiveTurn = activeTurns.setActiveTurn({
      id: activeTurnId,
      actController: turnController,
      approvalController,
    });

    const runSignal = AbortSignal.any([signal, turnController.signal]);
    const stopTyping = startTelegramTypingIndicator({
      api: telegram.bot.api,
      chatId: payload.telegram.chatId,
      threadId: payload.telegram.threadId,
      signal: runSignal,
    });
    capabilityPrompts.setTurnContext({ ctx, signal: approvalController.signal });
    const actStarted = performance.now();
    let completed = false;
    let workSettled = false;
    let delegatedToTurnRunner = false;
    try {
      await telegramSessions.withSession(work.sessionId, async () => {
        await withBrokerGrantScope(
          "once",
          () =>
            cronCapabilities.withProfile(
              job.permissionProfile,
              job.id,
              async () => {
                const { tools, guardToolCall } = await createTurnToolSet({
                  userQuestions: createUnavailableUserInteractionPort(),
                  todoDisplay: createNoopTodoDisplayPort(),
                });
                logInfo("Queued cron work started.", { jobId: job.id, workId: work.id });
                const result = await traceSpan(
                  "lmstudio.act",
                  async (actSpan) => {
                    const observer = createModelActObserver();
                    const imageCount = userTurnImageCount(payload.input.message);
                    if (imageCount > 0) actSpan.setAttribute("user.images.count", imageCount);
                    delegatedToTurnRunner = true;
                    const turnResult = await runQueuedPreparedTurn({
                      events: coreEvents,
                      queue: workQueue,
                      context: agent.context,
                      egress: createTelegramTurnEgressPort({
                        sendMessage: (chatId, text, options) => telegram.bot.api.sendMessage(chatId, text, options),
                      }),
                      baseSystemPrompt: workspace.systemPrompt,
                      work,
                      userMessage: payload.input.message,
                      tools,
                      guardToolCall,
                      observer,
                      signal: runSignal,
                      abortDisposition: () => signal.aborted ? "release" : "cancel",
                      fallbackText: "Cron job finished without a reply.",
                    });
                    const turnTokens = (await agent.modelAct.countTokens(turnResult.persistedMessages))
                      .reduce((sum, count) => sum + count, 0);
                    if (turnResult.finalization) {
                      actSpan.setAttribute("context.tokens", tokenBucket(turnResult.finalization.totalTokens));
                    }
                    actSpan.setAttribute("turn.tokens", tokenBucket(turnTokens));
                    actSpan.setAttribute("reply.count", turnResult.replyTexts.length);
                    if (turnResult.firstTokenMs !== undefined) {
                      actSpan.setAttribute("first_token.ms", Math.round(turnResult.firstTokenMs));
                    }
                    return turnResult;
                  },
                  { attributes: { "tools.count": tools.length } },
                );
                logInfo(`Queued cron work finished (${result.replyTexts.length} reply chunk(s)).`, {
                  jobId: job.id,
                  workId: work.id,
                });
                if (result.finalization?.compacted) {
                  logDebug("session.compacted", { sessionId: agent.sessions.current.id });
                }
                workSettled = true;
              },
              {
                onApprovedToolRule: async (rule) => {
                  await cronStore.addPermissionRules(job.id, { toolRules: [rule] });
                },
                onApprovedBrokerRule: async (rule) => {
                  await cronStore.addPermissionRules(job.id, { brokerRules: [rule] });
                },
              },
            ),
        );
        try {
          await completeCronRunSchedule(cronStore, job, payload);
        } catch (scheduleError) {
          logError("cron.schedule_complete_error", {
            jobId: job.id,
            workId: work.id,
            message: errorMessage(scheduleError),
          });
        }
        completed = true;
      });
    } catch (error) {
      if (!workSettled) {
        if (!delegatedToTurnRunner && isAbortError(error) && turnController.signal.aborted && !signal.aborted) {
          await workQueue.cancel(work.id, { reason: "Cron turn aborted." });
        } else if (!delegatedToTurnRunner && isAbortError(error) && signal.aborted) {
          await workQueue.release(work.id, { leaseId: work.lease.id });
        } else if (!delegatedToTurnRunner) {
          await workQueue.fail(work.id, {
            leaseId: work.lease.id,
            reason: errorMessage(error),
          });
        }
        workSettled = true;
      }
      if (!isAbortError(error)) {
        try {
          await failCronRunSchedule(cronStore, job, payload, errorMessage(error));
        } catch (scheduleError) {
          logError("cron.schedule_fail_error", {
            jobId: job.id,
            workId: work.id,
            message: errorMessage(scheduleError),
          });
        }
        try {
          await sendQueuedModelReply(
            work,
            payload,
            [],
            "Cron job failed. Check /cron list for details.",
          );
        } catch (sendError) {
          logError("telegram.queued_cron_error_reply_failed", { message: errorMessage(sendError) });
        }
      }
      throw error;
    } finally {
      recordActDuration(performance.now() - actStarted, completed ? "ok" : "error");
      clearActiveTurn();
      signal.removeEventListener("abort", onShutdown);
      if (!completed) {
        approvalController.abort();
        brokerPermissionPrompts.abortPending();
        capabilityPrompts.abortPending();
      }
      stopTyping();
      capabilityPrompts.clearTurnContext();
      activeTurnId = "no-active-turn";
    }
  }

  async function runQueuedWork(work: LeasedWorkItem, signal: AbortSignal): Promise<void> {
    if (work.kind === "user_turn") {
      await runQueuedUserTurn(work, signal);
      return;
    }
    if (work.kind === "cron_run") {
      await runQueuedCronTurn(work, signal);
      return;
    }
    if (work.kind === "subagent_run") {
      await subagents.runQueuedWork(work, { signal });
      return;
    }
    if (work.kind === "maintenance") {
      await runQueuedMaintenanceWork({ queue: workQueue, work });
      return;
    }
    throw new Error(`Unsupported queued work kind in agent host: ${work.kind}`);
  }

  const telegram = createTelegramManager({
    sessions: telegramSessions,
    onAdminStart: async (ctx) => {
      const bootstrap = await readBootstrapIfPresent(workspace.path);
      if (bootstrap && ctx.message) {
        logDebug("bootstrap.start", { sessionId: agent.sessions.current.id, length: bootstrap.length });
        await submitTelegramUserTurn({
          ctx,
          input: { text: bootstrap },
          replyToMessageId: ctx.message.message_id,
          updateId: ctx.update.update_id,
          sessionId: agent.sessions.current.id,
        });
        return;
      }
    },
    userQuestions,
    capabilityPrompts,
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
  const queuedWorkProcessor = new QueuedTurnProcessor({
    queue: workQueue,
    workspaceGate,
    runner: {
      run: (work, options) => runQueuedWork(work, options.signal),
    },
    ownerId: workerOwnerId,
    kinds: ["user_turn", "cron_run", "subagent_run", "maintenance"],
  });
  const queuedWorker = createQueueWorker({
    processor: queuedWorkProcessor,
    signal: controller.signal,
    onError: (error) => {
      logError("queued_work.error", { message: errorMessage(error) });
    },
  });
  await runStartupRecovery({
    events: coreEvents,
    queue: workQueue,
    outbox: egressOutbox,
    ownerId: workerOwnerId,
    maxInterruptedAttempts: MAX_INTERRUPTED_WORK_ATTEMPTS,
    cronStore,
    telegramApi: {
      sendMessage: (chatId, text, options) => telegram.bot.api.sendMessage(chatId, text, options),
    },
    signal: controller.signal,
  });
  await subagents.recoverPendingOnStartup();
  const queuedWorkerTask = queuedWorker.start();
  queuedWorker.wake();

  setCronDispatcher(
    new CronDispatcher({
      store: cronStore,
      capabilities: cronCapabilities,
      signal: controller.signal,
      runner: {
        run: (job, _capabilities, _signal, dispatchedAt) =>
          telegramWorkIntake.submitCronRun({
            job,
            sessionId: agent.sessions.current.id,
            dispatchedAt,
          }),
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

          const durableImages = await durableTelegramImages(payload.items);
          const images = await prepareDurableUserImages(lmstudio.client, durableImages);
          const input: UserTurnInput = {
            text: payload.text ?? DEFAULT_IMAGE_PROMPT,
            images,
            durableImages,
          };

          logInfo(
            `Telegram album flush (${payload.items.length} image(s), media_group_id=${payload.mediaGroupId}).`,
          );

          actMs = await submitTelegramUserTurn({
            ctx: payload.turnCtx,
            input,
            replyToMessageId: payload.context.replyToMessageId,
            updateId: payload.turnCtx.update.update_id,
            sessionId: agent.sessions.current.id,
          });
        },
        { root: true },
      );
    } catch (error) {
      outcome = "error";
      const ctx = payload.turnCtx;
      if (isImageInputError(error) && ctx.message) {
        await ctx.reply(errorMessage(error), { message_thread_id: ctx.message.message_thread_id });
        return;
      }
      logDebug("telegram.album.error", {
        message: errorMessage(error),
      });
      logError("telegram.album.exception", { message: errorMessage(error) });
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

  async function cleanupStep(name: string, step: () => void | Promise<void>): Promise<void> {
    try {
      await Promise.try(step);
    } catch (error) {
      logError("shutdown.cleanup_error", { step: name, message: errorMessage(error) });
    }
  }

  function cleanup(): Promise<void> {
    cleanupPromise ??= (async () => {
      controller.abort();
      await cleanupStep("queue.worker.stop", async () => {
        if (queuedWorkerTask) await queuedWorkerTask;
      });
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
      await telegramWorkIntake.cancelConversation({
        target: {
          chatId: ctx.chat?.id ?? ctx.message.chat.id,
          ...(ctx.message.message_thread_id !== undefined ? { threadId: ctx.message.message_thread_id } : {}),
        },
        reason: "Turn aborted.",
        reply: { ctx, abortedActiveTurn: aborted },
      });
      return;
    }

    if (userQuestions.isPending() || capabilityPrompts.isPending()) {
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
              await ctx.reply(errorMessage(error), { message_thread_id: message.message_thread_id });
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

          actMs = await submitTelegramUserTurn({
            ctx,
            input: userInput,
            replyToMessageId: message.message_id,
            updateId: ctx.update.update_id,
            sessionId: agent.sessions.current.id,
          });
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
        await ctx.reply(errorMessage(error), { message_thread_id: ctx.message.message_thread_id });
        return;
      }
      logDebug("telegram.message.error", {
        message: errorMessage(error),
      });
      logError("telegram.message.exception", { message: errorMessage(error) });
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
  void runAgentHost();
}
