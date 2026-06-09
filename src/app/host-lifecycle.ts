import { errorMessage, logError } from "../shared/mod.ts";

/** Registers SIGINT/SIGTERM shutdown hooks. */
export function registerShutdown(runShutdown: () => Promise<void>): void {
  const onShutdownSignal = (): void => {
    void runShutdown();
  };
  Deno.addSignalListener("SIGINT", onShutdownSignal);
  Deno.addSignalListener("SIGTERM", onShutdownSignal);
}

/** Returns true for abort-like errors produced by DOM, Deno, or model adapters. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}

/** Runs one shutdown cleanup step and records failures without interrupting later steps. */
export async function cleanupStep(name: string, step: () => void | Promise<void>): Promise<void> {
  try {
    await Promise.try(step);
  } catch (error) {
    logError("shutdown.cleanup_error", { step: name, message: errorMessage(error) });
  }
}
