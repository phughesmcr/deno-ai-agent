import { errorMessage, isAbortError, logError } from "../shared/mod.ts";

export { isAbortError };

/** Registers SIGINT/SIGTERM shutdown hooks. */
export function registerShutdown(runShutdown: () => Promise<void>): void {
  const onShutdownSignal = (): void => {
    void runShutdown();
  };
  Deno.addSignalListener("SIGINT", onShutdownSignal);
  Deno.addSignalListener("SIGTERM", onShutdownSignal);
}

/** Runs one shutdown cleanup step and records failures without interrupting later steps. */
export async function cleanupStep(name: string, step: () => void | Promise<void>): Promise<void> {
  try {
    await Promise.try(step);
  } catch (error) {
    logError("shutdown.cleanup_error", { step: name, message: errorMessage(error) });
  }
}
