import { sendControlGrant } from "./control-channel.ts";

export type BrokerGrantScope = "once" | "session";

/** Returns the Deno `net` permission value for an HTTP(S) URL. */
export function brokerNetValueForUrl(url: URL): string {
  const port = url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  return port ? `${url.hostname}:${port}` : url.hostname;
}

/**
 * Pre-grants broker `net` for an approved HTTP(S) URL origin.
 * @internal
 */
export async function grantBrokerNetUrl(url: URL, scope: BrokerGrantScope = "session"): Promise<void> {
  await sendControlGrant("net", brokerNetValueForUrl(url), scope);
}
