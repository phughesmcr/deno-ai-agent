/** Minimal MCP stdio server for integration tests (tools/list + tools/call). */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
        capabilities: { tools: {} },
        serverInfo: { name: "mock", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [{
          name: "echo",
          description: "Echo args",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        }],
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
