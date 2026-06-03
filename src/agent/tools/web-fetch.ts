import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { grantBrokerNetUrl, shouldRunPermissionControlClient } from "../../permission-broker/mod.ts";
import { approveToolOperation, type ToolContext } from "./context.ts";

const DEFAULT_TIMEOUT_SECONDS = 15;
const MAX_TIMEOUT_SECONDS = 60;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 128 * 1024;

type WebFetchFetcher = (input: URL, init: RequestInit) => Promise<Response>;
type BrokerNetGrant = (url: URL, scope: "once") => Promise<void>;

export interface WebFetchToolOptions {
  /** Fetch implementation, injectable for tests. */
  fetcher?: WebFetchFetcher;
  /** Broker net grant implementation, injectable for tests. */
  grantBrokerNet?: BrokerNetGrant;
  /** Maximum response body bytes decoded for text output. */
  maxBodyBytes?: number;
}

interface RedirectEntry {
  status: number;
  from: string;
  to: string;
}

interface WebFetchResult {
  status: number;
  requestedUrl: string;
  finalUrl: string;
  contentType: string | null;
  redirectChain: RedirectEntry[];
  text?: string;
  bodyNote?: string;
}

interface ReadTextResult {
  text: string;
  truncated: boolean;
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web-fetch only accepts http: and https: URLs.");
  }
  if (url.username || url.password) {
    throw new Error("web-fetch does not accept URLs with credentials.");
  }
  return url;
}

function timeoutSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("timeout must be a positive number of seconds.");
  return Math.min(value, MAX_TIMEOUT_SECONDS);
}

function approvalSummary(url: URL): string {
  return `GET ${url.pathname || "/"}`;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("text/") ||
    type === "application/json" ||
    type.endsWith("+json") ||
    type === "application/xml" ||
    type.endsWith("+xml") ||
    type === "application/xhtml+xml" ||
    type === "application/javascript" ||
    type === "application/ecmascript";
}

async function readBoundedText(response: Response, maxBytes: number): Promise<ReadTextResult> {
  if (!response.body) return { text: "", truncated: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (total <= maxBytes) {
      // deno-lint-ignore no-await-in-loop -- Stream chunks must be consumed sequentially.
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, Math.max(0, remaining)));
        total = maxBytes;
        truncated = true;
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { text: new TextDecoder().decode(output), truncated };
}

async function approveAndGrant(
  ctx: ToolContext,
  url: URL,
  grantBrokerNet: BrokerNetGrant,
  approvedOrigins: Set<string>,
): Promise<void> {
  if (approvedOrigins.has(url.origin)) return;

  await approveToolOperation(ctx, {
    operation: "network",
    target: url.origin,
    risk: "high",
    summary: approvalSummary(url),
  });

  if (shouldRunPermissionControlClient()) {
    await grantBrokerNet(url, "once");
  }
  approvedOrigins.add(url.origin);
}

async function fetchWithRedirects(
  ctx: ToolContext,
  startUrl: URL,
  fetcher: WebFetchFetcher,
  grantBrokerNet: BrokerNetGrant,
  signal: AbortSignal,
  maxBodyBytes: number,
): Promise<WebFetchResult> {
  const requestedUrl = startUrl.href;
  const redirectChain: RedirectEntry[] = [];
  const approvedOrigins = new Set<string>();
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    // deno-lint-ignore no-await-in-loop -- Redirect approval must precede each fetch.
    await approveAndGrant(ctx, currentUrl, grantBrokerNet, approvedOrigins);

    // deno-lint-ignore no-await-in-loop -- Redirects are intentionally followed manually.
    const response = await fetcher(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal,
    });

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return {
          status: response.status,
          requestedUrl,
          finalUrl: currentUrl.href,
          contentType: response.headers.get("content-type"),
          redirectChain,
          bodyNote: "Redirect response did not include a Location header.",
        };
      }

      if (redirectCount === MAX_REDIRECTS) {
        throw new Error(`Redirect limit exceeded after ${MAX_REDIRECTS} redirects.`);
      }

      const nextUrl = parseHttpUrl(new URL(location, currentUrl).href);
      redirectChain.push({ status: response.status, from: currentUrl.href, to: nextUrl.href });
      currentUrl = nextUrl;
      continue;
    }

    const contentType = response.headers.get("content-type");
    const result: WebFetchResult = {
      status: response.status,
      requestedUrl,
      finalUrl: currentUrl.href,
      contentType,
      redirectChain,
    };

    if (!isTextualContentType(contentType)) {
      result.bodyNote = "Response body omitted because Content-Type is not text.";
      return result;
    }

    // deno-lint-ignore no-await-in-loop -- Body read happens only for the terminal non-redirect response.
    const body = await readBoundedText(response, maxBodyBytes);
    result.text = body.text;
    if (body.truncated) {
      result.bodyNote = `Response text truncated at ${maxBodyBytes} bytes.`;
    }
    return result;
  }

  throw new Error(`Redirect limit exceeded after ${MAX_REDIRECTS} redirects.`);
}

/** LM Studio tool for approved HTTP(S) GET requests that returns bounded text snapshots. */
export function createWebFetchTool(ctx: ToolContext, options: WebFetchToolOptions = {}): Tool {
  const fetcher = options.fetcher ?? fetch;
  const grantBrokerNet = options.grantBrokerNet ?? grantBrokerNetUrl;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;

  return tool({
    name: "web-fetch",
    description:
      "Fetch an approved HTTP/HTTPS website document with GET only. Follows up to 5 redirects manually. Returns status, URLs, content type, redirect chain, and a bounded text body for textual responses. Does not send custom headers, cookies, request bodies, or non-GET methods.",
    parameters: {
      url: z.string().describe("HTTP or HTTPS URL to fetch. Credentials are rejected."),
      timeout: z.number().optional().describe(
        `Timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SECONDS}; maximum ${MAX_TIMEOUT_SECONDS}.`,
      ),
    },
    implementation: async ({ url: rawUrl, timeout }) => {
      const startUrl = parseHttpUrl(rawUrl);
      const seconds = timeoutSeconds(timeout);
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), seconds * 1000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutController.signal]) : timeoutController.signal;

      try {
        const result = await fetchWithRedirects(ctx, startUrl, fetcher, grantBrokerNet, signal, maxBodyBytes);
        return JSON.stringify(result, null, 2);
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new Error(`web-fetch timed out after ${seconds} seconds.`);
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  });
}
