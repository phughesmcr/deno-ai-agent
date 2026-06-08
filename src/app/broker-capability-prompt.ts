import type { CapabilityDecisionResult, CapabilityRequest } from "../core/mod.ts";
import type {
  PermissionCallbackDispatch,
  PermissionPromptPort,
  PermissionPromptRequest,
  PermissionPromptResult,
  PermissionPromptTurnTarget,
} from "../permission-broker/mod.ts";
import { errorMessage, logDebug } from "../shared/mod.ts";

/** Capability authorizer used by the broker permission prompt adapter. */
export interface BrokerCapabilityAuthorizer {
  decide(request: CapabilityRequest, signal?: AbortSignal): Promise<CapabilityDecisionResult>;
}

/** Options for adapting broker permission prompts into capability requests. */
export interface BrokerCapabilityPromptPortOptions {
  /** Per-turn or process-wide capability authorizer. */
  authorizer: BrokerCapabilityAuthorizer;
  /** Current session id for the active broker prompt. */
  getSessionId: () => string;
  /** Current work id for the active broker prompt, when known. */
  getWorkId?: () => string | undefined;
  /** Prompt timeout used for broker capability requests. */
  timeoutMs?: number;
}

const DEFAULT_PERMISSION_PROMPT_TIMEOUT_MS = 120_000;

function targetForPrompt(request: PermissionPromptRequest): string {
  return request.value ?? "(none)";
}

function capabilityRequest(
  request: PermissionPromptRequest,
  options: BrokerCapabilityPromptPortOptions,
): CapabilityRequest {
  const target = targetForPrompt(request);
  const workId = options.getWorkId?.();
  return {
    id: request.requestId,
    sessionId: options.getSessionId(),
    ...(workId !== undefined ? { workId } : {}),
    source: "broker_permission",
    capability: {
      kind: "broker_permission",
      target,
      action: request.permission,
    },
    risk: "high",
    summary: "Deno permission broker request",
    timeoutMs: options.timeoutMs ?? DEFAULT_PERMISSION_PROMPT_TIMEOUT_MS,
    display: {
      action: request.permission,
      target,
    },
  };
}

function brokerResult(result: CapabilityDecisionResult): PermissionPromptResult {
  if (!result.allowed) return { result: "deny" };
  if (result.grant === "session" || result.scope === "session") {
    return { result: "allow", grant: "session" };
  }
  return { result: "allow" };
}

/** Creates a broker PermissionPromptPort backed by the core capability decision path. */
export function createBrokerCapabilityPromptPort(
  options: BrokerCapabilityPromptPortOptions,
): PermissionPromptPort {
  let promptController: AbortController | undefined;

  return {
    isPending(): boolean {
      return promptController !== undefined && !promptController.signal.aborted;
    },
    setTurnContext(_target: PermissionPromptTurnTarget): void {},
    clearTurnContext(): void {},
    async prompt(request: PermissionPromptRequest, signal?: AbortSignal): Promise<PermissionPromptResult> {
      promptController = new AbortController();
      const effectiveSignal = signal ? AbortSignal.any([signal, promptController.signal]) : promptController.signal;
      try {
        const decision = await options.authorizer.decide(capabilityRequest(request, options), effectiveSignal);
        return brokerResult(decision);
      } catch (error) {
        logDebug("permission_broker.capability_prompt_error", {
          requestId: request.requestId,
          message: errorMessage(error),
        });
        return { result: "deny" };
      } finally {
        promptController = undefined;
      }
    },
    handleCallback(): Promise<PermissionCallbackDispatch> {
      return Promise.resolve({ handled: false });
    },
    abortPending(): void {
      promptController?.abort();
      promptController = undefined;
    },
  };
}
