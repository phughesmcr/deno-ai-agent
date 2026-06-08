import type { Tool } from "@lmstudio/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client";

import type { UserInteractionPort } from "../agent/tools/user-question-port.ts";
import { grantBrokerNetUrl } from "../permission-broker/mod.ts";
import { errorMessage } from "../shared/error.ts";
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
import { readMcpResourceText } from "./resources.ts";
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
  onPromptsListChanged?: () => void;
  onResourcesListChanged?: () => void;
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
      onPromptsListChanged: this._options.onPromptsListChanged,
      onResourcesListChanged: this._options.onResourcesListChanged,
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
    const budgeted = applyToolBudget(filtered.exposed, this._options.maxToolsTotal);
    const omitted = [...budgeted.omittedToolNames, ...filtered.omittedToolNames];

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
    const budgeted = applyToolBudget(filtered.exposed, maxToolsTotal);
    this._state.listedTools = allTools;
    this._state.omittedToolNames = [...budgeted.omittedToolNames, ...filtered.omittedToolNames];
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
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this._state) return "Error: MCP server not connected.";
    if (this._config.transport === "http" && this._config.url) {
      await grantBrokerNetUrl(new URL(this._config.url));
    }

    const callOnce = async (): Promise<string> => {
      const result = await this._state!.client.callTool({ name: toolName, arguments: args });
      return await formatConnectionToolResult(
        result as import("./content.ts").McpCallToolResult,
        this._state!.client,
        this._options.autoReadResourceLinks,
      );
    };

    if (!this._options.elicitationEnabled) {
      try {
        return await callOnce();
      } catch (error) {
        return handleCallToolError(error, this._options);
      }
    }

    try {
      return await callOnce();
    } catch (error) {
      const retry = await tryUrlElicitationRetry(
        error,
        this._options.userInteraction,
        signal ?? new AbortController().signal,
        this._config.id,
      );
      if (retry === "retry") {
        try {
          return await callOnce();
        } catch (e2) {
          return handleCallToolError(e2, this._options);
        }
      }
      return handleCallToolError(error, this._options);
    }
  }
}

async function formatConnectionToolResult(
  result: import("./content.ts").McpCallToolResult,
  client: Client,
  autoReadResourceLinks: boolean,
): Promise<string> {
  const formatted = formatCallToolResult(result);
  if (!autoReadResourceLinks) return formatted;

  const resourceBlocks: string[] = [];
  for (const item of result.content) {
    if (item.type !== "resource_link") continue;
    const uri = item["uri"];
    if (typeof uri !== "string" || uri.length === 0) continue;
    try {
      const text = await readMcpResourceText(client, uri);
      resourceBlocks.push(`Resource ${uri}:\n${text}`);
    } catch (error) {
      const message = errorMessage(error);
      resourceBlocks.push(`Resource ${uri}:\nError reading resource: ${message}`);
    }
  }

  if (resourceBlocks.length === 0) return formatted;
  return `${formatted}\n\n${resourceBlocks.join("\n\n")}`;
}

function filterTools(
  tools: McpListedTool[],
  config: ResolvedMcpServerConfig,
): { exposed: McpListedTool[]; omittedToolNames: string[] } {
  let list = tools;
  if (config.includeTools?.length) {
    const allow = new Set(config.includeTools);
    list = list.filter((t) => allow.has(t.name));
  }
  if (config.excludeTools?.length) {
    const deny = new Set(config.excludeTools);
    list = list.filter((t) => !deny.has(t.name));
  }
  return {
    exposed: list.slice(0, config.maxTools),
    omittedToolNames: list.slice(config.maxTools).map((tool) => tool.name),
  };
}

function applyToolBudget(
  tools: McpListedTool[],
  maxTotal: number,
): { exposed: McpListedTool[]; omittedToolNames: string[] } {
  return {
    exposed: tools.slice(0, maxTotal),
    omittedToolNames: tools.slice(maxTotal).map((tool) => tool.name),
  };
}

function handleCallToolError(error: unknown, options: McpConnectionOptions): string {
  const message = errorMessage(error);
  if (!options.elicitationEnabled && message.toLowerCase().includes("elicitation")) {
    return MCP_ELICITATION_UNAVAILABLE;
  }
  return `Error: ${message}`;
}

async function tryUrlElicitationRetry(
  error: unknown,
  port: UserInteractionPort,
  signal: AbortSignal,
  serverId: string,
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
      serverId,
    });
    if (result.action !== "accept") return "none";
    await port.waitForUrlElicitationComplete?.(el.elicitationId, signal);
  }
  return "retry";
}
