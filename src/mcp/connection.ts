import type { Tool } from "@lmstudio/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client";

import type { UserInteractionPort } from "../agent/tools/user-question-port.ts";
import { grantBrokerNetUrl } from "../permission-broker/mod.ts";
import { logDebug, logError, logInfo } from "../shared/log.ts";
import { createMcpClient } from "./client-factory.ts";
import type { ResolvedMcpServerConfig } from "./config.ts";
import { MCP_CONNECT_TIMEOUT_MS, withTimeout } from "./connect-timeout.ts";
import { formatCallToolResult, MCP_ELICITATION_UNAVAILABLE, MCP_URL_ELICITATION_REQUIRED_CODE } from "./content.ts";
import { registerElicitationHandler } from "./elicitation-handler.ts";
import { grantMcpHttpBrokerAccess } from "./grant-http.ts";
import { grantMcpStdioBrokerAccess } from "./grant-stdio.ts";
import { attachMcpNotificationHandlers } from "./notifications.ts";
import { ElicitationGate } from "./parallel.ts";
import { createLmToolsForServer, type McpListedTool } from "./tools-adapter.ts";
import { DenoStdioClientTransport } from "./transports/deno-stdio.ts";
import { createHttpTransport } from "./transports/http.ts";

import { stdioChildEnv } from "./stdio-env.ts";

export interface McpConnectionError {
  serverId: string;
  message: string;
}

export interface McpConnectionState {
  config: ResolvedMcpServerConfig;
  client: Client;
  listedTools: McpListedTool[];
  omittedToolNames: string[];
  lmTools: Tool[];
  supportsPrompts: boolean;
  supportsResources: boolean;
}

export interface McpConnectionOptions {
  userInteraction: UserInteractionPort;
  elicitationEnabled: boolean;
  maxToolsTotal: number;
  autoReadResourceLinks: boolean;
  onToolsListChanged: () => void;
}

/** One connected MCP server session. */
export class McpConnection {
  readonly serverId: string;
  readonly transportKind: "http" | "stdio";
  private readonly _gate = new ElicitationGate();
  private _state: McpConnectionState | undefined;

  constructor(
    private readonly _config: ResolvedMcpServerConfig,
    private readonly _options: McpConnectionOptions,
  ) {
    this.serverId = _config.id;
    this.transportKind = _config.transport;
  }

  get state(): McpConnectionState | undefined {
    return this._state;
  }

  get lmTools(): Tool[] {
    return this._state?.lmTools ?? [];
  }

  get omittedToolNames(): string[] {
    return this._state?.omittedToolNames ?? [];
  }

  async connect(): Promise<void> {
    const client = createMcpClient({
      listChanged: {
        tools: { onChanged: () => this._options.onToolsListChanged() },
      },
    });

    const transport = this._config.transport === "http" ?
      createHttpTransport(this._config.url!) :
      new DenoStdioClientTransport({
        command: this._config.command!,
        args: this._config.args,
        cwd: this._config.cwd,
        env: stdioChildEnv(this._config.env),
      });

    if (this._config.transport === "http") {
      logInfo(`MCP server ${this._config.id}: granting HTTP broker access...`);
      const grantController = new AbortController();
      try {
        await withTimeout(
          grantMcpHttpBrokerAccess(this._config, grantController.signal),
          MCP_CONNECT_TIMEOUT_MS,
          `MCP HTTP broker grant (${this._config.id})`,
        );
      } catch (error) {
        grantController.abort();
        throw error;
      }
      logInfo(`MCP server ${this._config.id}: HTTP broker access granted.`);
    }

    if (this._config.transport === "stdio") {
      logInfo(`MCP server ${this._config.id}: granting stdio broker access...`);
      const grantController = new AbortController();
      try {
        await withTimeout(
          grantMcpStdioBrokerAccess(this._config, grantController.signal),
          MCP_CONNECT_TIMEOUT_MS,
          `MCP stdio broker grant (${this._config.id})`,
        );
      } catch (error) {
        grantController.abort();
        throw error;
      }
      logInfo(`MCP server ${this._config.id}: stdio broker access granted.`);
    }

    registerElicitationHandler(client, this._options.userInteraction, {
      enabled: this._options.elicitationEnabled,
      serverId: this._config.id,
    }, this._gate);

    attachMcpNotificationHandlers(client, this._options.userInteraction, {
      onToolsListChanged: this._options.onToolsListChanged,
    });

    try {
      logInfo(`MCP server ${this._config.id}: starting transport handshake...`);
      await withTimeout(
        client.connect(transport),
        MCP_CONNECT_TIMEOUT_MS,
        `MCP connect (${this._config.id})`,
      );
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    }
    logInfo(`MCP server ${this._config.id}: transport handshake complete.`);

    const caps = client.getServerCapabilities();
    logInfo(`MCP server ${this._config.id}: listing tools...`);
    const listResult = await withTimeout(
      client.listTools(),
      MCP_CONNECT_TIMEOUT_MS,
      `MCP tools/list (${this._config.id})`,
    );
    logInfo(`MCP server ${this._config.id}: tools listed.`);
    const allTools: McpListedTool[] = listResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));

    const filtered = filterTools(allTools, this._config);
    const budgeted = applyToolBudget(filtered, this._options.maxToolsTotal);
    const omitted = filtered.slice(budgeted.exposed.length).map((t) => t.name);

    const lmTools = createLmToolsForServer({
      serverId: this._config.id,
      transport: this._config.transport,
      tools: budgeted.exposed,
      callTool: (name, args, signal) => this.callTool(name, args, signal),
    });

    this._state = {
      config: this._config,
      client,
      listedTools: allTools,
      omittedToolNames: omitted,
      lmTools,
      supportsPrompts: Boolean(caps?.prompts),
      supportsResources: Boolean(caps?.resources),
    };

    logDebug("mcp.connected", { serverId: this._config.id, tools: budgeted.exposed.length });
  }

  async refreshTools(maxToolsTotal: number): Promise<void> {
    if (!this._state) return;
    const listResult = await this._state.client.listTools();
    const allTools: McpListedTool[] = listResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    const filtered = filterTools(allTools, this._config);
    const budgeted = applyToolBudget(filtered, maxToolsTotal);
    this._state.listedTools = allTools;
    this._state.omittedToolNames = filtered.slice(budgeted.exposed.length).map((t) => t.name);
    this._state.lmTools = createLmToolsForServer({
      serverId: this._config.id,
      transport: this._config.transport,
      tools: budgeted.exposed,
      callTool: (name, args, signal) => this.callTool(name, args, signal),
    });
  }

  async close(): Promise<void> {
    if (!this._state) return;
    try {
      await this._state.client.close();
    } catch (error) {
      logError("mcp.close_error", { serverId: this.serverId, error: String(error) });
    }
    this._state = undefined;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    _signal?: AbortSignal,
  ): Promise<string> {
    if (!this._state) return "Error: MCP server not connected.";
    if (this._config.transport === "http" && this._config.url) {
      await grantBrokerNetUrl(new URL(this._config.url));
    }

    const run = async (): Promise<string> => {
      try {
        const result = await this._state!.client.callTool({ name: toolName, arguments: args });
        return formatCallToolResult(result as import("./content.ts").McpCallToolResult);
      } catch (error) {
        return handleCallToolError(error, this._options);
      }
    };

    if (!this._options.elicitationEnabled) {
      try {
        return await run();
      } catch (error) {
        return handleCallToolError(error, this._options);
      }
    }

    try {
      return await run();
    } catch (error) {
      const retry = await tryUrlElicitationRetry(error, this._state.client, this._options.userInteraction);
      if (retry === "retry") {
        try {
          return await run();
        } catch (e2) {
          return handleCallToolError(e2, this._options);
        }
      }
      return handleCallToolError(error, this._options);
    }
  }
}

function filterTools(tools: McpListedTool[], config: ResolvedMcpServerConfig): McpListedTool[] {
  let list = tools;
  if (config.includeTools?.length) {
    const allow = new Set(config.includeTools);
    list = list.filter((t) => allow.has(t.name));
  }
  if (config.excludeTools?.length) {
    const deny = new Set(config.excludeTools);
    list = list.filter((t) => !deny.has(t.name));
  }
  return list.slice(0, config.maxTools);
}

function applyToolBudget(
  tools: McpListedTool[],
  maxTotal: number,
): { exposed: McpListedTool[] } {
  return { exposed: tools.slice(0, maxTotal) };
}

function handleCallToolError(error: unknown, options: McpConnectionOptions): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!options.elicitationEnabled && message.toLowerCase().includes("elicitation")) {
    return MCP_ELICITATION_UNAVAILABLE;
  }
  return `Error: ${message}`;
}

async function tryUrlElicitationRetry(
  error: unknown,
  _client: Client,
  port: UserInteractionPort,
): Promise<"retry" | "none"> {
  const code = (error as { code?: number })?.code;
  const data = (error as { data?: { elicitations?: unknown[] } })?.data;
  if (code !== MCP_URL_ELICITATION_REQUIRED_CODE || !Array.isArray(data?.elicitations)) {
    return "none";
  }

  for (const item of data.elicitations) {
    const el = item as { mode?: string; message?: string; url?: string; elicitationId?: string };
    if (el.mode !== "url" || !el.url || !el.message || !el.elicitationId) continue;
    const result = await port.interact({
      mode: "mcp_url",
      message: el.message,
      url: el.url,
      elicitationId: el.elicitationId,
      serverId: "mcp",
    });
    if (result.action !== "accept") return "none";
  }
  return "retry";
}
