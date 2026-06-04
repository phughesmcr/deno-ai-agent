import * as path from "@std/path";

import {
  grantBrokerReadPath,
  grantBrokerRunForCommands,
  grantBrokerRunOnceForAnyCommand,
  shouldRunPermissionControlClient,
} from "../permission-broker/mod.ts";
import { logInfo } from "../shared/log.ts";
import type { ResolvedMcpServerConfig } from "./config.ts";
import { stdioBrokerReadPaths } from "./stdio-env.ts";

/** Pre-grants broker permissions needed to spawn and feed an MCP stdio server. */
export async function grantMcpStdioBrokerAccess(
  config: ResolvedMcpServerConfig,
  signal?: AbortSignal,
): Promise<void> {
  if (!shouldRunPermissionControlClient() || config.transport !== "stdio" || !config.command) {
    return;
  }

  const runNames = new Set<string>([config.command]);

  for (const arg of config.args) {
    if (!path.isAbsolute(arg)) continue;
    runNames.add(arg);
  }

  logInfo(`MCP server ${config.id}: granting run permissions...`);
  await grantBrokerRunOnceForAnyCommand(signal);
  await grantBrokerRunForCommands([...runNames], signal);
  logInfo(`MCP server ${config.id}: run permissions granted.`);

  for (const readPath of stdioBrokerReadPaths({ args: config.args, cwd: config.cwd })) {
    logInfo(`MCP server ${config.id}: granting read permission for ${readPath}...`);
    await grantBrokerReadPath(readPath, signal);
  }
  logInfo(`MCP server ${config.id}: read permissions granted.`);
}
