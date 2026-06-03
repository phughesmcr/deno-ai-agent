let activeTurn: Promise<void> = Promise.resolve();

/** Abort controllers for the currently running Telegram-triggered model turn. */
export interface ActiveTurn {
  /** Telegram update id or other stable turn identifier. */
  id: string;
  /** Cancels LM Studio act and act-scoped adapters. */
  actController: AbortController;
  /** Cancels approval and permission prompts bound to this turn. */
  approvalController: AbortController;
}

/** Tracks the one model turn that can be aborted out-of-band from Telegram commands. */
export class ActiveTurnRegistry {
  #active: ActiveTurn | undefined;

  /** Sets the active turn and returns an idempotent cleanup function. */
  setActiveTurn(turn: ActiveTurn): () => void {
    this.#active = turn;
    return () => {
      if (this.#active === turn) this.#active = undefined;
    };
  }

  /** Active model-act signal, if a turn is currently running. */
  get actSignal(): AbortSignal | undefined {
    return this.#active?.actController.signal;
  }

  /** Aborts the active turn, if present. */
  abortActiveTurn(): boolean {
    const turn = this.#active;
    if (!turn) return false;
    turn.actController.abort();
    turn.approvalController.abort();
    return true;
  }
}

/**
 * Runs fn after any in-flight agent turn completes (one turn at a time).
 * @internal
 */
export async function withTurnMutex(fn: () => Promise<void>): Promise<void> {
  const previous = activeTurn;
  let release!: () => void;
  activeTurn = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await fn();
  } finally {
    release();
  }
}
