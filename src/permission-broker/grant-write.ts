import { sendControlGrant } from "./control-channel.ts";
import { currentBrokerGrantScope } from "./grant-scope.ts";

/** Values Deno may send on the broker `write` permission for the same file. */
function writeGrantValues(absolutePath: string): string[] {
  const values = new Set<string>([absolutePath, JSON.stringify(absolutePath)]);
  return [...values];
}

/**
 * Pre-grants broker `write` for a host file path (multiple value shapes).
 * @internal
 */
export async function grantBrokerWritePath(absolutePath: string, signal?: AbortSignal): Promise<void> {
  for (const value of new Set(writeGrantValues(absolutePath))) {
    if (signal?.aborted) return;
    // deno-lint-ignore no-await-in-loop -- Grant frames must stay in order on the control socket.
    await sendControlGrant("write", value, signal, currentBrokerGrantScope());
  }
}
