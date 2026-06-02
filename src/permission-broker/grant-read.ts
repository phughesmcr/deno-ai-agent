import { sendControlGrant } from "./control-channel.ts";

/** Values Deno may send on the broker `read` permission for the same file. */
function readGrantValues(absolutePath: string): string[] {
  const values = new Set<string>([absolutePath, JSON.stringify(absolutePath)]);
  return [...values];
}

/**
 * Pre-grants broker `read` for a host file path (multiple value shapes).
 * @internal
 */
export async function grantBrokerReadPaths(absolutePath: string): Promise<void> {
  for (const value of new Set(readGrantValues(absolutePath))) {
    await sendControlGrant("read", value, "session");
  }
}
