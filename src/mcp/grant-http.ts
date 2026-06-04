import { grantBrokerNetUrl } from "../permission-broker/mod.ts";
import { logInfo } from "../shared/log.ts";
import type { ResolvedMcpServerConfig } from "./config.ts";

/** Pre-grants broker network access needed to connect an HTTP MCP server. */
export async function grantMcpHttpBrokerAccess(config: ResolvedMcpServerConfig, signal?: AbortSignal): Promise<void> {
  if (config.transport !== "http" || !config.url) return;

  const url = new URL(config.url);
  logInfo(`MCP server ${config.id}: granting net permission for ${url.origin}...`);
  await grantBrokerNetUrl(url, "session", signal);
  logInfo(`MCP server ${config.id}: net permission granted.`);
}
