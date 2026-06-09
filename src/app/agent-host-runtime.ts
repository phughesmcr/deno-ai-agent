import type { Tool } from "@lmstudio/sdk";

import {
  createAgent,
  createLMStudioManager,
  createNoopTodoDisplayPort,
  createSkillManager,
  createToolContext,
  createUnavailableUserInteractionPort,
  createWorkspace,
  DenoKvTodoStore,
  getModelToolSet,
  McpRegistry,
  readBootstrapIfPresent,
  setMcpSystemPromptAppendix,
  SubagentRuntime,
} from "../agent/mod.ts";
import {
  CapabilityDecisionService,
  CapabilityLedger,
  createDurableUserInteractionPort,
  createQueueWorker,
  EgressOutbox,
  KvKernelStore,
  type LeasedWorkItem,
  QueuedTurnProcessor,
  WorkspaceGate,
} from "../core/mod.ts";
import { isTerminalWorkStatus } from "../core/work-state.ts";
import { createCronCapabilityDelegate, CronCommandManager, CronDispatcher, CronJobStore } from "../cron/mod.ts";
import { setCronDispatcher } from "../cron/runtime.ts";
import {
  assertPermissionBrokerSupported,
  runPermissionControlClient,
  shouldRunPermissionControlClient,
  waitForPermissionControlClient,
  withBrokerGrantScope,
} from "../permission-broker/mod.ts";
import { errorMessage, loadAppConfig, logDebug, logError, logInfo, traceSpan } from "../shared/mod.ts";
import {
  ActiveTurnRegistry,
  createTelegramCapabilityPromptPort,
  createTelegramManager,
  createTelegramTodoDisplayPort,
  createTelegramUserInteractionPort,
  createWhisperCliTranscriber,
  getTelegramBotToken,
  prepareDurableUserImages,
  startTelegramBot,
  startTelegramTypingIndicator,
  TelegramSessionBindingStore,
  TelegramSessionCoordinator,
} from "../telegram/mod.ts";
import { createBrokerCapabilityPromptPort } from "./broker-capability-prompt.ts";
import { completeCronRunSchedule, failCronRunSchedule } from "./cron-work.ts";
import { cleanupStep, isAbortError, registerShutdown } from "./host-lifecycle.ts";
import { QueuedImageStore } from "./image-store.ts";
import { runQueuedMaintenanceWork } from "./maintenance-work.ts";
import { createTelegramSendApi, type QueueWakeRef, runQueuedTelegramTurn } from "./queued-telegram-turn.ts";
import { runStartupRecovery } from "./startup-recovery.ts";
import type { TelegramEgressApi } from "./telegram-egress.ts";
import { registerTelegramMessageIntake } from "./telegram-message-intake.ts";
import { createQueuedTelegramTurnContext, sendQueuedTelegramModelReply } from "./telegram-turn-target.ts";
import { type SubmitTelegramUserTurnRequest, TelegramWorkIntake } from "./telegram-work-intake.ts";
import {
  cronRunWorkPayload,
  prepareQueuedModelMessage,
  type UserTurnWorkPayload,
  userTurnWorkPayload,
} from "./work-payload.ts";

const MAX_INTERRUPTED_WORK_ATTEMPTS = 3;

/** Runs the Telegram-backed Silas agent host until shutdown. */
export async function runAgentHostRuntime(): Promise<void> {
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
  const kernel = new KvKernelStore(workspaceKv);
  const coreEvents = kernel;
  const egressOutbox = new EgressOutbox(coreEvents);
  const capabilityLedger = new CapabilityLedger({ kv: workspaceKv, events: coreEvents });
  const capabilityDecisions = new CapabilityDecisionService({ ledger: capabilityLedger, events: coreEvents });
  const workQueue = kernel;
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
  const queueWake: QueueWakeRef = { wake: () => {} };
  const telegramSendApi = {
    sendMessage: ((chatId: number, text: string, options?: Parameters<TelegramEgressApi["sendMessage"]>[2]) => {
      if (!telegramSendApi.api) throw new Error("Telegram send API is not ready.");
      return telegramSendApi.api.sendMessage(chatId, text, options);
    }) as TelegramEgressApi["sendMessage"],
    api: null as ReturnType<typeof createTelegramSendApi> | null,
  };
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
    for (const err of mcpRegistry.connectionErrors) {
      logError("mcp.connection_error", { serverId: err.serverId, message: err.message });
    }
  } else {
    logInfo("MCP registry ready.");
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
    events: coreEvents,
    queue: workQueue,
    model: agent.modelAct,
    workspace: toolContext,
    skills,
    getSessionId: () => agent.sessions.current.id,
    wakeQueue: () => queueWake.wake(),
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
    telegramApi: telegramSendApi,
    typingApi: {
      sendChatAction: (chatId, action, options) => telegram.bot.api.sendChatAction(chatId, action, options),
    },
    typingSignal: controller.signal,
    wakeQueue: () => queueWake.wake(),
    currentSessionId: () => agent.sessions.current.id,
  });

  async function sendQueuedErrorReply(work: LeasedWorkItem, payload: UserTurnWorkPayload): Promise<void> {
    await sendQueuedTelegramModelReply({
      outbox: egressOutbox,
      api: telegramSendApi,
      work,
      payload,
      replyTexts: [],
      fallbackText: "Something went wrong while handling your message. Please try again.",
    });
  }

  async function submitTelegramUserTurn(request: SubmitTelegramUserTurnRequest): Promise<void> {
    if (!request.ctx.chat || !request.ctx.message) return;
    await telegramWorkIntake.submitUserTurn(request);
  }

  async function runQueuedUserTurn(work: LeasedWorkItem, signal: AbortSignal): Promise<void> {
    const payload = userTurnWorkPayload(work.payload);
    const liveCtx = telegramWorkIntake.liveContext(work.id);
    const ctx = liveCtx ?? createQueuedTelegramTurnContext({
      target: payload.telegram,
      adminId: config.TELEGRAM_ADMIN_ID,
      api: telegram.bot.api,
    });
    await runQueuedTelegramTurn({
      work,
      signal,
      ctx,
      events: coreEvents,
      queue: workQueue,
      context: agent.context,
      modelAct: agent.modelAct,
      workspaceSystemPrompt: workspace.systemPrompt,
      sendApi: telegramSendApi,
      activeTurns,
      capabilityPrompts,
      brokerPermissionPrompts,
      setActiveTurnId: (id) => {
        activeTurnId = id;
      },
      clearActiveTurnId: () => {
        activeTurnId = "no-active-turn";
      },
      beforeAct: ({ runSignal }) => {
        telegramWorkIntake.ensureTyping(work.id, payload.telegram);
        if (liveCtx) userQuestions.setTurnContext({ ctx: liveCtx, signal: runSignal });
        todoDisplay.setTurnContext({ ctx, signal: runSignal });
      },
      runSessionWork: async (runAct) => {
        await telegramSessions.withSession(work.sessionId, async () => {
          const { tools, guardToolCall } = await createTurnToolSet({
            ...(liveCtx ? {} : { userQuestions: createUnavailableUserInteractionPort() }),
          });
          const userMessage = await prepareQueuedModelMessage(
            payload.input,
            (images) => imageStore.loadImages(images),
            (images) => prepareDurableUserImages(lmstudio.client, images),
          );
          await runAct({
            userMessage,
            tools,
            guardToolCall,
            fallbackText: "The model finished without a reply. Try again or rephrase.",
            startedLog: "Queued Telegram work started.",
            finishedLog: (replyCount) => `Queued Telegram work finished (${replyCount} reply chunk(s)).`,
          });
        });
      },
      onActError: async (error) => {
        if (!isAbortError(error)) {
          try {
            await sendQueuedErrorReply(work, payload);
          } catch (sendError) {
            logError("telegram.queued_error_reply_failed", { message: errorMessage(sendError) });
          }
        }
      },
      onFinally: async () => {
        if (liveCtx) userQuestions.clearTurnContext();
        const finalWork = await workQueue.get(work.id);
        if (finalWork && isTerminalWorkStatus(finalWork.status) && payload.input.durableImages?.length) {
          try {
            await imageStore.deleteImages(payload.input.durableImages);
          } catch (error) {
            logError("telegram.queued_image_cleanup_failed", { message: errorMessage(error) });
          }
        }
        todoDisplay.clearTurnContext();
        telegramWorkIntake.deleteLiveContext(work.id);
      },
    });
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

    const ctx = createQueuedTelegramTurnContext({
      target: payload.telegram,
      adminId: config.TELEGRAM_ADMIN_ID,
      api: telegram.bot.api,
    });
    let stopTyping = (): void => {};
    await runQueuedTelegramTurn({
      work,
      signal,
      ctx,
      events: coreEvents,
      queue: workQueue,
      context: agent.context,
      modelAct: agent.modelAct,
      workspaceSystemPrompt: workspace.systemPrompt,
      sendApi: telegramSendApi,
      activeTurns,
      capabilityPrompts,
      brokerPermissionPrompts,
      cancelReason: "Cron turn aborted.",
      setActiveTurnId: (id) => {
        activeTurnId = id;
      },
      clearActiveTurnId: () => {
        activeTurnId = "no-active-turn";
      },
      beforeAct: () => {
        stopTyping = startTelegramTypingIndicator({
          api: telegram.bot.api,
          chatId: payload.telegram.chatId,
          threadId: payload.telegram.threadId,
          signal: controller.signal,
        });
      },
      runSessionWork: async (runAct) => {
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
                  await runAct({
                    userMessage: payload.input.message,
                    tools,
                    guardToolCall,
                    fallbackText: "Cron job finished without a reply.",
                    startedLog: `Queued cron work started.`,
                    finishedLog: (replyCount) => `Queued cron work finished (${replyCount} reply chunk(s)).`,
                  });
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
        });
      },
      onActError: async (error) => {
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
            await sendQueuedTelegramModelReply({
              outbox: egressOutbox,
              api: telegramSendApi,
              work,
              payload,
              replyTexts: [],
              fallbackText: "Cron job failed. Check /cron list for details.",
            });
          } catch (sendError) {
            logError("telegram.queued_cron_error_reply_failed", { message: errorMessage(sendError) });
          }
        }
      },
      onFinally: (): Promise<void> => {
        stopTyping();
        return Promise.resolve();
      },
    });
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
  telegramSendApi.api = createTelegramSendApi(telegram.bot.api);
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
    telegramApi: telegramSendApi,
    signal: controller.signal,
  });
  queueWake.wake = () => queuedWorker.wake();
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

  const mediaGroupBuffer = registerTelegramMessageIntake({
    bot: telegram.bot,
    botToken,
    client: lmstudio.client,
    audioTranscriber,
    intake: telegramWorkIntake,
    abortActiveTurn,
    isInteractionPending: () => userQuestions.isPending() || capabilityPrompts.isPending(),
    currentSessionId: () => agent.sessions.current.id,
    submitUserTurn: submitTelegramUserTurn,
  });

  let intentionalShutdown = false;
  let cleanupPromise: Promise<void> | undefined;

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

/** Runs the Telegram-backed Silas agent host until shutdown. */
export function runAgentHost(): Promise<void> {
  return runAgentHostRuntime();
}

if (import.meta.main) {
  void runAgentHost();
}
