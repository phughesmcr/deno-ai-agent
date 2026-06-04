import { loadBrokerDaemonEnv, PermissionBrokerDaemon } from "./daemon.ts";
import { logDebug } from "./log.ts";
import { assertPermissionBrokerSupported } from "./version.ts";

const encoder = new TextEncoder();

async function main(): Promise<void> {
  assertPermissionBrokerSupported();
  const env = loadBrokerDaemonEnv();
  const controller = new AbortController();
  const shutdown = (): void => controller.abort();
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  const daemon = new PermissionBrokerDaemon(env);
  await Deno.stdout.write(
    encoder.encode(`Silas permission broker listening\n  broker:  ${env.brokerPath}\n  control: ${env.controlPath}\n`),
  );
  logDebug("permission_broker.daemon_start", {
    workspace: env.workspacePath,
    runPrompts: String(env.runPromptsEnabled),
  });
  await daemon.run(controller.signal);
}

if (import.meta.main) {
  void main();
}
