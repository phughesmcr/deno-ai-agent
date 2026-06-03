interface PendingInteraction<TRequest, TResult> {
  request: TRequest;
  resolve: (result: TResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  abortHandler: () => void;
  signal: AbortSignal;
}

interface BeginPendingInteractionParams<TRequest, TResult> {
  request: TRequest;
  signal: AbortSignal;
  timeoutMs: number;
  resolve: (result: TResult) => void;
  abortResult: () => TResult;
  timeoutResult: () => TResult;
}

export interface PendingInteractionStore<TRequest, TResult> {
  isPending(): boolean;
  current(): { request: TRequest } | undefined;
  begin(params: BeginPendingInteractionParams<TRequest, TResult>): boolean;
  settle(result: TResult): { request: TRequest } | undefined;
}

/** Owns the common Telegram pending-interaction lifecycle. @internal */
export function createPendingInteractionStore<TRequest, TResult>(
  onSettled?: (request: TRequest, result: TResult) => void,
): PendingInteractionStore<TRequest, TResult> {
  let pending: PendingInteraction<TRequest, TResult> | undefined;

  function settle(result: TResult): { request: TRequest } | undefined {
    const current = pending;
    if (!current) return undefined;
    pending = undefined;
    clearTimeout(current.timeoutId);
    current.signal.removeEventListener("abort", current.abortHandler);
    onSettled?.(current.request, result);
    current.resolve(result);
    return { request: current.request };
  }

  return {
    isPending: () => pending !== undefined,
    current: () => pending,
    begin(params: BeginPendingInteractionParams<TRequest, TResult>): boolean {
      if (pending) return false;
      const abortHandler = (): void => {
        settle(params.abortResult());
      };
      const timeoutId = setTimeout(() => settle(params.timeoutResult()), params.timeoutMs);
      pending = {
        request: params.request,
        resolve: params.resolve,
        timeoutId,
        abortHandler,
        signal: params.signal,
      };
      params.signal.addEventListener("abort", abortHandler, { once: true });
      return true;
    },
    settle,
  };
}
