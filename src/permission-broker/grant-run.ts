import { sendControlGrant } from "./control-channel.ts";

/**
 * Pre-grants broker `run` values for approved commands.
 * @internal
 */
export async function grantBrokerRunValues(values: readonly string[]): Promise<void> {
  for (const value of new Set(values)) {
    // deno-lint-ignore no-await-in-loop -- Grant frames must stay in order on the control socket.
    await sendControlGrant("run", value, "session");
  }
}
