/** Reserved meta-tool suffixes (double mcp_ prefix in full name). */
export const META_TOOL_GET_PROMPT = "mcp_get_prompt";
export const META_TOOL_READ_RESOURCE = "mcp_read_resource";

const PREFIX = "mcp__";

/** Builds `mcp__<serverId>__<toolName>`. */
export function formatMcpToolName(serverId: string, toolName: string): string {
  return `${PREFIX}${serverId}__${toolName}`;
}

/** Parses `mcp__<serverId>__<toolName>` or returns null. */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const serverId = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  if (!serverId || !toolName) return null;
  return { serverId, toolName };
}

export function isMcpToolName(name: string): boolean {
  return parseMcpToolName(name) !== null;
}
