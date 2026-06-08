import type { Tool } from "@lmstudio/sdk";

import type { UserInteractionPort } from "../agent/tools/user-question-port.ts";
import { errorMessage } from "../shared/error.ts";
import { logDebug, logError, logInfo } from "../shared/log.ts";
import { type LoadedMcpConfig, loadMcpConfig } from "./config.ts";
import { McpConnection, type McpConnectionError } from "./connection.ts";
import { formatPromptsAppendix, getMcpPromptText, listMcpPrompts } from "./prompts.ts";
import { formatResourcesAppendix, listMcpResources, readMcpResourceText } from "./resources.ts";
import { createGetPromptTool, createReadResourceTool } from "./tools-adapter.ts";

export interface McpRegistryOptions {
  workspacePath: string;
  userInteraction: UserInteractionPort;
  /** When false, MCP elicitation requests are declined instead of prompting the user. */
  elicitationEnabled?: boolean;
}

/** Manages MCP server connections and exposes tools to the agent. */
export class McpRegistry {
  private readonly _connections = new Map<string, McpConnection>();
  private _config: LoadedMcpConfig | undefined;
  private _connectionErrors: McpConnectionError[] = [];
  private _promptAppendix = "";
  private _omittedToolsAppendix = "";

  constructor(private readonly _options: McpRegistryOptions) {}

  get connectionErrors(): readonly McpConnectionError[] {
    return this._connectionErrors;
  }

  get systemPromptAppendix(): string {
    return this._promptAppendix + this._omittedToolsAppendix;
  }

  /** Loads config and connects enabled servers (fail-open per server). */
  async connectAll(): Promise<void> {
    this._config = await loadMcpConfig(this._options.workspacePath);
    this._connectionErrors = [];
    await this.closeAll();

    let remainingBudget = this._config.maxToolsTotal;

    for (const server of this._config.servers) {
      if (!server.enabled) continue;
      const conn = new McpConnection(server, {
        userInteraction: this._options.userInteraction,
        elicitationEnabled: this._options.elicitationEnabled ?? false,
        maxToolsTotal: remainingBudget,
        autoReadResourceLinks: this._config.autoReadResourceLinks,
        onToolsListChanged: () => {
          void this.refreshTools();
        },
        onPromptsListChanged: () => {
          void this.rebuildAppendices();
        },
        onResourcesListChanged: () => {
          void this.rebuildAppendices();
        },
      });
      try {
        logInfo(`Connecting MCP server ${server.id} (${server.transport})...`);
        await conn.connect();
        remainingBudget = Math.max(0, remainingBudget - conn.lmTools.length);
        this._connections.set(server.id, conn);
        logInfo(`MCP server ${server.id} connected (${conn.lmTools.length} tool(s)).`);
      } catch (error) {
        const message = errorMessage(error);
        logError("mcp.connect_failed", { serverId: server.id, message });
        this._connectionErrors.push({ serverId: server.id, message });
      }
    }

    await this.rebuildAppendices();
    logDebug("mcp.registry_ready", {
      servers: this._connections.size,
      errors: this._connectionErrors.length,
    });
  }

  async refreshTools(): Promise<void> {
    if (!this._config) return;
    let remaining = this._config.maxToolsTotal;
    for (const conn of this._connections.values()) {
      await conn.refreshTools(remaining);
      remaining = Math.max(0, remaining - conn.lmTools.length);
    }
    await this.rebuildAppendices();
  }

  getTools(): Tool[] {
    const tools: Tool[] = [];
    for (const conn of this._connections.values()) {
      tools.push(...conn.lmTools);
      const state = conn.state;
      if (!state) continue;
      if (state.supportsPrompts) {
        tools.push(
          createGetPromptTool(
            conn.serverId,
            conn.transportKind,
            (name, args) => getMcpPromptText(state.client, name, args),
          ),
        );
      }
      if (state.supportsResources) {
        tools.push(
          createReadResourceTool(conn.serverId, conn.transportKind, (uri) => readMcpResourceText(state.client, uri)),
        );
      }
    }
    return tools;
  }

  async closeAll(): Promise<void> {
    for (const conn of this._connections.values()) {
      await conn.close();
    }
    this._connections.clear();
    this._promptAppendix = "";
    this._omittedToolsAppendix = "";
  }

  private async rebuildAppendices(): Promise<void> {
    const promptParts: string[] = [];
    const omittedParts: string[] = [];

    for (const conn of this._connections.values()) {
      const state = conn.state;
      if (!state) continue;
      if (state.supportsPrompts) {
        try {
          const prompts = await listMcpPrompts(state.client);
          promptParts.push(formatPromptsAppendix(conn.serverId, prompts));
        } catch { /* ignore */ }
      }
      if (state.supportsResources) {
        try {
          const resources = await listMcpResources(state.client);
          promptParts.push(formatResourcesAppendix(conn.serverId, resources));
        } catch { /* ignore */ }
      }
      if (conn.omittedToolNames.length > 0) {
        omittedParts.push(
          `\n## MCP tools not exposed (${conn.serverId})\n${conn.omittedToolNames.map((n) => `- ${n}`).join("\n")}\n`,
        );
      }
    }

    this._promptAppendix = promptParts.join("");
    this._omittedToolsAppendix = omittedParts.join("");
  }
}
