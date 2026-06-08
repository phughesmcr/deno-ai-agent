import * as path from "@std/path";
import type { Client } from "@modelcontextprotocol/sdk/client";
import { assertEquals } from "jsr:@std/assert@1";

import {
  createUnavailableUserInteractionPort,
  type UserInteractionRequest,
  type UserInteractionResult,
} from "../../src/agent/tools/user-question-port.ts";
import { MCP_URL_ELICITATION_REQUIRED_CODE } from "../../src/mcp/content.ts";
import { McpConnection, type McpConnectionState } from "../../src/mcp/connection.ts";

const mockServer = path.fromFileUrl(
  new URL("./mock-stdio-server.ts", import.meta.url),
);

class FakeMcpClient {
  readonly calls: unknown[] = [];

  callTool(request: unknown): Promise<unknown> {
    this.calls.push(request);
    if (this.calls.length === 1) {
      return Promise.reject(Object.assign(new Error("URL approval required"), {
        code: MCP_URL_ELICITATION_REQUIRED_CODE,
        data: {
          elicitations: [{
            mode: "url",
            message: "Open the consent page",
            url: "https://example.com/consent",
            elicitationId: "url-1",
          }],
        },
      }));
    }
    return Promise.resolve({ content: [{ type: "text", text: "retried ok" }] });
  }
}

class FakeResourceLinkMcpClient {
  readonly calls: unknown[] = [];
  readonly resourceReads: unknown[] = [];

  callTool(request: unknown): Promise<unknown> {
    this.calls.push(request);
    return Promise.resolve({
      content: [{
        type: "resource_link",
        name: "handbook",
        uri: "file:///workspace/handbook.md",
        mimeType: "text/markdown",
        description: "Agent handbook",
      }],
    });
  }

  readResource(request: unknown): Promise<unknown> {
    this.resourceReads.push(request);
    return Promise.resolve({
      contents: [{
        uri: "file:///workspace/handbook.md",
        mimeType: "text/markdown",
        text: "Use durable events for replay.",
      }],
    });
  }
}

class FakeInteractionPort {
  readonly requests: UserInteractionRequest[] = [];
  readonly waitedIds: string[] = [];
  private readonly _completion = Promise.withResolvers<void>();

  isAvailable(): boolean {
    return true;
  }

  isPending(): boolean {
    return false;
  }

  setTurnContext(): void {}

  clearTurnContext(): void {}

  interact(request: UserInteractionRequest): Promise<UserInteractionResult> {
    this.requests.push(request);
    return Promise.resolve({ action: "accept" });
  }

  waitForUrlElicitationComplete(elicitationId: string): Promise<void> {
    this.waitedIds.push(elicitationId);
    return this._completion.promise;
  }

  complete(): void {
    this._completion.resolve();
  }
}

async function waitUntil(predicate: () => boolean, deadline = performance.now() + 500): Promise<void> {
  if (predicate()) return;
  if (performance.now() > deadline) throw new Error("Timed out waiting for condition");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await waitUntil(predicate, deadline);
}

Deno.test("McpConnection waits for URL elicitation completion before retrying tool call", async () => {
  const port = new FakeInteractionPort();
  const client = new FakeMcpClient();
  const connection = new McpConnection({
    id: "docs",
    enabled: true,
    transport: "stdio",
    command: Deno.execPath(),
    args: [],
    env: {},
    maxTools: 20,
  }, {
    userInteraction: port,
    elicitationEnabled: true,
    maxToolsTotal: 20,
    autoReadResourceLinks: false,
    onToolsListChanged: () => {},
  });
  (connection as unknown as { _state: McpConnectionState })._state = {
    config: {
      id: "docs",
      enabled: true,
      transport: "stdio",
      command: Deno.execPath(),
      args: [],
      env: {},
      maxTools: 20,
    },
    client: client as unknown as Client,
    listedTools: [],
    omittedToolNames: [],
    lmTools: [],
    supportsPrompts: false,
    supportsResources: false,
  };

  const result = connection.callTool("search", { q: "silas" });
  await waitUntil(() => port.waitedIds.length === 1);

  assertEquals(client.calls.length, 1);
  assertEquals(port.waitedIds, ["url-1"]);
  assertEquals(port.requests, [{
    mode: "mcp_url",
    message: "Open the consent page",
    url: "https://example.com/consent",
    elicitationId: "url-1",
    serverId: "docs",
  }]);

  port.complete();
  assertEquals(await result, "retried ok");
  assertEquals(client.calls.length, 2);
});

Deno.test("McpConnection auto-reads resource links when enabled", async () => {
  const port = new FakeInteractionPort();
  const client = new FakeResourceLinkMcpClient();
  const connection = new McpConnection({
    id: "docs",
    enabled: true,
    transport: "stdio",
    command: Deno.execPath(),
    args: [],
    env: {},
    maxTools: 20,
  }, {
    userInteraction: port,
    elicitationEnabled: false,
    maxToolsTotal: 20,
    autoReadResourceLinks: true,
    onToolsListChanged: () => {},
  });
  (connection as unknown as { _state: McpConnectionState })._state = {
    config: {
      id: "docs",
      enabled: true,
      transport: "stdio",
      command: Deno.execPath(),
      args: [],
      env: {},
      maxTools: 20,
    },
    client: client as unknown as Client,
    listedTools: [],
    omittedToolNames: [],
    lmTools: [],
    supportsPrompts: false,
    supportsResources: true,
  };

  const result = await connection.callTool("search", { q: "silas" });

  assertEquals(client.calls.length, 1);
  assertEquals(client.resourceReads, [{ uri: "file:///workspace/handbook.md" }]);
  assertEquals(
    result,
    "Resource link: handbook uri=file:///workspace/handbook.md type=text/markdown - Agent handbook\n\n" +
      "Resource file:///workspace/handbook.md:\nUse durable events for replay.",
  );
});

Deno.test("McpConnection forwards prompt and resource catalog change notifications", async () => {
  let toolChanges = 0;
  let promptChanges = 0;
  let resourceChanges = 0;
  const connection = new McpConnection({
    id: "docs",
    enabled: true,
    transport: "stdio",
    command: Deno.execPath(),
    args: ["run", "-A", mockServer, "--notify-catalog-changes"],
    env: {},
    maxTools: 20,
  }, {
    userInteraction: createUnavailableUserInteractionPort(),
    elicitationEnabled: false,
    maxToolsTotal: 20,
    autoReadResourceLinks: false,
    onToolsListChanged: () => {
      toolChanges += 1;
    },
    onPromptsListChanged: () => {
      promptChanges += 1;
    },
    onResourcesListChanged: () => {
      resourceChanges += 1;
    },
  });

  await connection.connect();
  await waitUntil(() => promptChanges === 1 && resourceChanges === 1);

  assertEquals(toolChanges, 0);
  assertEquals(promptChanges, 1);
  assertEquals(resourceChanges, 1);

  await connection.close();
});
