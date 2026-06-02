// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

/** One runtime permission prompt shown in Telegram. */
export interface PermissionPromptRequest {
  requestId: string;
  brokerId: number;
  permission: string;
  value: string | null;
}

/** User decision for a permission prompt. */
export type PermissionPromptResult = {
  result: "allow" | "deny";
  grant?: "once" | "session";
};

/** Minimal Telegram context for permission prompts. */
export interface PermissionPromptTurnContext {
  config: { adminId: number; isAdmin: boolean };
  message?: { message_thread_id?: number; chat?: { id: number } };
  reply(
    text: string,
    options?: {
      reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
      message_thread_id?: number;
    },
  ): Promise<unknown>;
}

/** Active turn binding for permission prompts. */
export interface PermissionPromptTurnTarget {
  ctx: PermissionPromptTurnContext;
  signal: AbortSignal;
}

/**
 * Port that renders Deno permission broker prompts in Telegram.
 * @internal
 */
export interface PermissionPromptPort {
  isPending(): boolean;
  setTurnContext(target: PermissionPromptTurnTarget): void;
  clearTurnContext(): void;
  prompt(request: PermissionPromptRequest, signal?: AbortSignal): Promise<PermissionPromptResult>;
  handleCallback(data: string, actorId: number | undefined, adminId: number): Promise<boolean>;
  abortPending(reason?: string): void;
}

/** Port used when the control channel is unavailable. */
export function createUnavailablePermissionPromptPort(): PermissionPromptPort {
  return {
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    prompt: () => Promise.resolve({ result: "deny" }),
    handleCallback: () => Promise.resolve(false),
    abortPending: () => {},
  };
}
