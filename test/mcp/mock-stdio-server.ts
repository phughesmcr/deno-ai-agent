/** Minimal MCP stdio server for integration tests. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const notifyCatalogChanges = Deno.args.includes("--notify-catalog-changes");
const withPromptsResources = Deno.args.includes("--with-prompts-resources");
const withManyTools = Deno.args.includes("--many-tools");

function send(msg: unknown): void {
  const line = JSON.stringify(msg) + "\n";
  Deno.stdout.writeSync(encoder.encode(line));
}

function handle(msg: { id?: number; method?: string; params?: unknown }): void {
  const id = msg.id;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          tools: {},
          ...(withPromptsResources ? { prompts: {}, resources: {} } : {}),
        },
        serverInfo: { name: "mock", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") {
    if (notifyCatalogChanges) {
      send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
      send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    }
    return;
  }
  if (msg.method === "tools/list") {
    const tools = [{
      name: "echo",
      description: "Echo args",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    }];
    if (withManyTools) {
      tools.push(
        {
          name: "inspect",
          description: "Inspect args",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
        {
          name: "search",
          description: "Search args",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
        {
          name: "summarize",
          description: "Summarize args",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      );
    }
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools,
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const params = msg.params as { name: string; arguments?: { text?: string } };
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `echo:${params.arguments?.text ?? ""}` }],
      },
    });
    return;
  }
  if (withPromptsResources && msg.method === "prompts/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        prompts: [{
          name: "review",
          description: "Review a topic",
        }],
      },
    });
    return;
  }
  if (withPromptsResources && msg.method === "prompts/get") {
    const params = msg.params as { name: string; arguments?: { topic?: string } };
    send({
      jsonrpc: "2.0",
      id,
      result: {
        messages: [{
          role: "user",
          content: { type: "text", text: `${params.name}:${params.arguments?.topic ?? ""}` },
        }],
      },
    });
    return;
  }
  if (withPromptsResources && msg.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [{
          uri: "file:///workspace/guide.md",
          name: "guide",
          description: "Workspace guide",
          mimeType: "text/markdown",
        }],
      },
    });
    return;
  }
  if (withPromptsResources && msg.method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{
          uri: "file:///workspace/guide.md",
          mimeType: "text/markdown",
          text: "Durable MCP resource text.",
        }],
      },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

async function main(): Promise<void> {
  let buffer = "";
  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk);
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      handle(JSON.parse(line));
    }
  }
}

void main();
