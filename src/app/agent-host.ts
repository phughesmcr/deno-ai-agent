import { runAgentHostRuntime } from "./agent-host-runtime.ts";

/** Runs the Telegram-backed Silas agent host until shutdown. */
export function runAgentHost(): Promise<void> {
  return runAgentHostRuntime();
}

if (import.meta.main) {
  void runAgentHost();
}
