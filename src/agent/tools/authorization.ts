export { createToolCallGuard } from "./registry.ts";

/** Model tool-call request shape used by LM Studio's guard hook. */
export interface GuardedToolCallRequest {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** Small structural subset of LM Studio's non-exported guard controller. */
export interface ToolCallGuardController {
  readonly toolCallRequest: GuardedToolCallRequest;
  allow(): void;
  deny(reason?: string): void;
  allowAndOverrideParameters(newParameters: Record<string, unknown>): void;
}

/** App-level guard function passed to the model act boundary. */
export type ToolCallGuard = (
  roundIndex: number,
  callId: number,
  controller: ToolCallGuardController,
) => void | Promise<void>;
