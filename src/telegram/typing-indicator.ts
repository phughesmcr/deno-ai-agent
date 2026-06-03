interface TelegramTypingApi {
  sendChatAction(
    chatId: number,
    action: "typing",
    options?: { message_thread_id?: number },
  ): Promise<unknown>;
}

interface TypingScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(id: unknown): void;
}

const defaultScheduler: TypingScheduler = {
  setInterval(callback, intervalMs): unknown {
    return globalThis.setInterval(callback, intervalMs);
  },
  clearInterval(id): void {
    globalThis.clearInterval(id as ReturnType<typeof globalThis.setInterval>);
  },
};

export interface TelegramTypingIndicatorOptions {
  api: TelegramTypingApi;
  chatId: number;
  threadId?: number;
  signal: AbortSignal;
  intervalMs?: number;
  scheduler?: TypingScheduler;
}

/** Starts Telegram's native typing indicator and refreshes it until stopped. @internal */
export function startTelegramTypingIndicator({
  api,
  chatId,
  threadId,
  signal,
  intervalMs = 4_000,
  scheduler = defaultScheduler,
}: TelegramTypingIndicatorOptions): () => void {
  if (signal.aborted) return () => {};

  let stopped = false;
  const options = threadId === undefined ? undefined : { message_thread_id: threadId };
  const sendTyping = async (): Promise<void> => {
    if (stopped || signal.aborted) return;
    try {
      await api.sendChatAction(chatId, "typing", options);
    } catch {
      /* typing indicator is best-effort */
    }
  };

  void sendTyping();
  const intervalId = scheduler.setInterval(() => void sendTyping(), intervalMs);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    scheduler.clearInterval(intervalId);
    signal.removeEventListener("abort", stop);
  };
  signal.addEventListener("abort", stop, { once: true });

  return stop;
}
