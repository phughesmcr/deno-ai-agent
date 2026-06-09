/** In-process FIFO gate for workspace-mutating work. */
export class WorkspaceGate {
  private _tail: Promise<void> = Promise.resolve();

  /** Runs one operation after all earlier operations have finished. */
  async runExclusive<T>(
    _label: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();

    const previous = this._tail;
    const next = Promise.withResolvers<void>();
    this._tail = previous.then(() => next.promise, () => next.promise);

    try {
      await previous;
      signal.throwIfAborted();
      return await operation();
    } finally {
      next.resolve();
    }
  }
}
