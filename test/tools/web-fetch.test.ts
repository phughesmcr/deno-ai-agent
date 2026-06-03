import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";

import {
  type ApprovalDecision,
  type ApprovalGate,
  approveDecision,
  createAutoApprovalGate,
  createDenyApprovalGate,
} from "../../src/shared/approval.ts";
import { createToolContext } from "../../src/agent/tools/context.ts";
import { createWebFetchTool } from "../../src/agent/tools/web-fetch.ts";
import { createTestWorkspace, runToolImplementation } from "./helpers.ts";

interface WebFetchJson {
  status: number;
  requestedUrl: string;
  finalUrl: string;
  contentType: string | null;
  redirectChain: Array<{ status: number; from: string; to: string }>;
  text?: string;
  bodyNote?: string;
}

function parseWebFetchJson(output: string): WebFetchJson {
  return JSON.parse(output) as WebFetchJson;
}

Deno.test("web-fetch rejects malformed, non-http, and credentialed URLs", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createWebFetchTool(ctx, {
      fetcher: () => Promise.resolve(new Response("unexpected")),
    });

    await assertRejects(() => runToolImplementation(tool, { url: "not a url" }), Error, "Invalid URL");
    await assertRejects(
      () => runToolImplementation(tool, { url: "file:///tmp/a.txt" }),
      Error,
      "http: and https:",
    );
    await assertRejects(
      () => runToolImplementation(tool, { url: "https://user:pass@example.com/" }),
      Error,
      "credentials",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("web-fetch does not fetch when approval is denied", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-web-fetch-" });
  let calls = 0;
  try {
    const ctx = await createToolContext(dir, {
      approvalGate: createDenyApprovalGate("network denied"),
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const tool = createWebFetchTool(ctx, {
      fetcher: () => {
        calls++;
        return Promise.resolve(new Response("unexpected"));
      },
    });

    await assertRejects(
      () => runToolImplementation(tool, { url: "https://example.com/page?secret=value" }),
      Error,
      "network denied",
    );
    assertEquals(calls, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("web-fetch returns metadata plus approved text body", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createWebFetchTool(ctx, {
      fetcher: (url, init) => {
        assertEquals(url.href, "https://example.com/page");
        assertEquals(init.method, "GET");
        assertEquals(init.redirect, "manual");
        return Promise.resolve(
          new Response("hello website", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
        );
      },
    });

    const json = parseWebFetchJson(await runToolImplementation(tool, { url: "https://example.com/page" }));

    assertEquals(json.status, 200);
    assertEquals(json.requestedUrl, "https://example.com/page");
    assertEquals(json.finalUrl, "https://example.com/page");
    assertEquals(json.contentType, "text/html; charset=utf-8");
    assertEquals(json.redirectChain, []);
    assertEquals(json.text, "hello website");
  } finally {
    await cleanup();
  }
});

Deno.test("web-fetch truncates text output with a clear notice", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createWebFetchTool(ctx, {
      maxBodyBytes: 5,
      fetcher: () =>
        Promise.resolve(
          new Response("hello world", {
            headers: { "content-type": "text/plain" },
          }),
        ),
    });

    const json = parseWebFetchJson(await runToolImplementation(tool, { url: "https://example.com/long" }));

    assertEquals(json.text, "hello");
    assertStringIncludes(json.bodyNote ?? "", "truncated at 5 bytes");
  } finally {
    await cleanup();
  }
});

Deno.test("web-fetch omits non-text response bodies", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createWebFetchTool(ctx, {
      fetcher: () =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "image/png" },
          }),
        ),
    });

    const json = parseWebFetchJson(await runToolImplementation(tool, { url: "https://example.com/image.png" }));

    assertEquals(json.text, undefined);
    assertStringIncludes(json.bodyNote ?? "", "not text");
  } finally {
    await cleanup();
  }
});

Deno.test("web-fetch follows relative and absolute redirects manually", async () => {
  const requests: string[] = [];
  const approvals: string[] = [];
  const approvalGate: ApprovalGate = {
    requestApproval(request): Promise<ApprovalDecision> {
      approvals.push(`${request.target} ${request.summary}`);
      return Promise.resolve(approveDecision("test"));
    },
  };
  const dir = await Deno.makeTempDir({ prefix: "silas-web-fetch-" });
  try {
    const ctx = await createToolContext(dir, {
      approvalGate,
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const tool = createWebFetchTool(ctx, {
      fetcher: (url) => {
        requests.push(url.href);
        if (url.href === "https://example.com/start") {
          return Promise.resolve(new Response("", { status: 302, headers: { location: "/middle" } }));
        }
        if (url.href === "https://example.com/middle") {
          return Promise.resolve(
            new Response("", {
              status: 301,
              headers: { location: "https://docs.example.org/final" },
            }),
          );
        }
        return Promise.resolve(new Response("done", { headers: { "content-type": "text/plain" } }));
      },
    });

    const json = parseWebFetchJson(await runToolImplementation(tool, { url: "https://example.com/start" }));

    assertEquals(requests, [
      "https://example.com/start",
      "https://example.com/middle",
      "https://docs.example.org/final",
    ]);
    assertEquals(approvals, [
      "https://example.com GET /start",
      "https://docs.example.org GET /final",
    ]);
    assertEquals(json.finalUrl, "https://docs.example.org/final");
    assertEquals(json.redirectChain.length, 2);
    assertEquals(json.text, "done");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("web-fetch reports redirect limit failures clearly", async () => {
  const { ctx, cleanup } = await createTestWorkspace();
  try {
    const tool = createWebFetchTool(ctx, {
      fetcher: (url) =>
        Promise.resolve(
          new Response("", {
            status: 302,
            headers: { location: `/next-${url.pathname.slice(1)}` },
          }),
        ),
    });

    await assertRejects(
      () => runToolImplementation(tool, { url: "https://example.com/start" }),
      Error,
      "Redirect limit exceeded after 5 redirects",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("web-fetch aborts on timeout", async () => {
  const dir = await Deno.makeTempDir({ prefix: "silas-web-fetch-" });
  try {
    const ctx = await createToolContext(dir, {
      approvalGate: createAutoApprovalGate("test"),
      sessionId: "session-1",
      turnId: "turn-1",
    });
    const tool = createWebFetchTool(ctx, {
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }),
    });

    await assertRejects(
      () => runToolImplementation(tool, { url: "https://example.com/slow", timeout: 0.01 }),
      Error,
      "timed out after 0.01 seconds",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
