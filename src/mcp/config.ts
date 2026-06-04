import * as path from "@std/path";

const DEFAULT_MAX_TOOLS_TOTAL = 40;
const DEFAULT_MAX_TOOLS_PER_SERVER = 20;

/** One MCP server entry in mcp.json. */
export interface McpServerConfig {
  enabled?: boolean;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  maxTools?: number;
  includeTools?: string[];
  excludeTools?: string[];
}

/** Loaded mcp.json shape. */
export interface McpConfigFile {
  maxToolsTotal?: number;
  autoReadResourceLinks?: boolean;
  servers: Record<string, McpServerConfig>;
}

/** Resolved server ready for connection. */
export interface ResolvedMcpServerConfig {
  id: string;
  enabled: boolean;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  maxTools: number;
  includeTools?: string[];
  excludeTools?: string[];
}

export interface LoadedMcpConfig {
  maxToolsTotal: number;
  autoReadResourceLinks: boolean;
  servers: ResolvedMcpServerConfig[];
}

function substituteEnv(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const v = Deno.env.get(name);
    if (v === undefined) throw new Error(`Environment variable ${name} is not set (required by mcp.json).`);
    return v;
  });
}

function substituteEnvRecord(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = substituteEnv(v);
  }
  return out;
}

function resolveServer(id: string, raw: McpServerConfig): ResolvedMcpServerConfig {
  const enabled = raw.enabled !== false;
  const hasUrl = typeof raw.url === "string" && raw.url.length > 0;
  const hasCommand = typeof raw.command === "string" && raw.command.length > 0;
  if (hasUrl === hasCommand) {
    throw new Error(`Server "${id}": specify exactly one of "url" or "command".`);
  }
  const transport = hasUrl ? "http" : "stdio";
  const env = raw.env ? substituteEnvRecord(raw.env) : {};
  const resolved: ResolvedMcpServerConfig = {
    id,
    enabled,
    transport,
    args: raw.args ?? [],
    env,
    maxTools: raw.maxTools ?? DEFAULT_MAX_TOOLS_PER_SERVER,
  };
  if (hasUrl) resolved.url = substituteEnv(raw.url!);
  if (hasCommand) {
    resolved.command = raw.command;
    if (raw.cwd) resolved.cwd = substituteEnv(raw.cwd);
  }
  if (raw.includeTools?.length) resolved.includeTools = raw.includeTools;
  if (raw.excludeTools?.length) resolved.excludeTools = raw.excludeTools;
  return resolved;
}

/** Loads `{workspace}/mcp.json` if present; otherwise empty config. */
export async function loadMcpConfig(workspacePath: string): Promise<LoadedMcpConfig> {
  const configPath = path.join(workspacePath, "mcp.json");
  try {
    const text = await Deno.readTextFile(configPath);
    const parsed = JSON.parse(text) as McpConfigFile;
    if (!parsed.servers || typeof parsed.servers !== "object") {
      throw new Error('mcp.json must contain a "servers" object.');
    }
    const ids = Object.keys(parsed.servers);
    if (new Set(ids).size !== ids.length) throw new Error("mcp.json contains duplicate server ids.");

    const servers: ResolvedMcpServerConfig[] = [];
    for (const [id, cfg] of Object.entries(parsed.servers)) {
      servers.push(resolveServer(id, cfg));
    }

    return {
      maxToolsTotal: parsed.maxToolsTotal ?? DEFAULT_MAX_TOOLS_TOTAL,
      autoReadResourceLinks: parsed.autoReadResourceLinks === true,
      servers,
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { maxToolsTotal: DEFAULT_MAX_TOOLS_TOTAL, autoReadResourceLinks: false, servers: [] };
    }
    throw error;
  }
}
