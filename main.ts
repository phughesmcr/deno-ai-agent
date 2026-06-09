import { runAgentHost } from "./src/app/agent-host-runtime.ts";

export { runAgentHost };

/** Starts the Silas agent host. */
if (import.meta.main) {
  void runAgentHost();
}
