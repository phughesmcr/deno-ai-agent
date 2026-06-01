let activeTurn: Promise<void> = Promise.resolve();

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
