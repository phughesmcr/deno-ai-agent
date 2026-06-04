/** Abort controllers for the currently running Telegram-triggered model turn. */
export interface ActiveTurn {
  /** Telegram update id or other stable turn identifier. */
  id: string;
  /** Cancels LM Studio act and act-scoped adapters. */
  actController: AbortController;
  /** Cancels approval and permission prompts bound to this turn. */
  approvalController: AbortController;
}

export type ActiveTurnHandle = (() => void) & Disposable;

function disposableCleanup(cleanup: () => void): ActiveTurnHandle {
  const handle = cleanup as ActiveTurnHandle;
  handle[Symbol.dispose] = cleanup;
  return handle;
}

/** Tracks the one model turn that can be aborted out-of-band from Telegram commands. */
export class ActiveTurnRegistry {
  private _active: ActiveTurn | undefined;

  /** Sets the active turn and returns an idempotent cleanup function. */
  setActiveTurn(turn: ActiveTurn): ActiveTurnHandle {
    this._active = turn;
    return disposableCleanup(() => {
      if (this._active === turn) this._active = undefined;
    });
  }

  /** Active model-act signal, if a turn is currently running. */
  get actSignal(): AbortSignal | undefined {
    return this._active?.actController.signal;
  }

  /** Aborts the active turn, if present. */
  abortActiveTurn(): boolean {
    const turn = this._active;
    if (!turn) return false;
    turn.actController.abort();
    turn.approvalController.abort();
    return true;
  }
}
