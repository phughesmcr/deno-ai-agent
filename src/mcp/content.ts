const DEFAULT_MAX_TEXT = 32_000;

/** MCP tools/call result shape (content blocks). */
export interface McpCallToolResult {
  isError?: boolean;
  content: Array<{ type: string; [key: string]: unknown }>;
}

function textFromItem(item: { type: string; [key: string]: unknown }): string | null {
  if (item.type !== "text") return null;
  const text = item["text"];
  return typeof text === "string" ? text : null;
}

/** Serializes MCP CallToolResult content for the model. */
export function formatCallToolResult(result: McpCallToolResult, maxText = DEFAULT_MAX_TEXT): string {
  const lines: string[] = [];
  if (result.isError) lines.push("[MCP tool error]");

  for (const item of result.content) {
    switch (item.type) {
      case "text": {
        const text = textFromItem(item);
        if (text !== null) {
          lines.push(text.length > maxText ? `${text.slice(0, maxText)}\n...[truncated]` : text);
        }
        break;
      }
      case "resource_link": {
        const name = item["name"];
        const uri = item["uri"];
        const mimeType = item["mimeType"];
        const description = item["description"];
        lines.push(
          `Resource link: ${typeof name === "string" ? name : "resource"} uri=${typeof uri === "string" ? uri : ""}${
            typeof mimeType === "string" ? ` type=${mimeType}` : ""
          }${typeof description === "string" ? ` - ${description}` : ""}`,
        );
        break;
      }
      case "resource": {
        const resource = item["resource"] as { uri?: string } | undefined;
        lines.push(`Embedded resource: ${resource?.uri ?? "unknown"}`);
        break;
      }
      case "image":
        lines.push(`[Image content: ${String(item["mimeType"] ?? "unknown")}]`);
        break;
      case "audio":
        lines.push(`[Audio content: ${String(item["mimeType"] ?? "unknown")}]`);
        break;
      default:
        lines.push(`[Unsupported content type: ${item.type}]`);
    }
  }

  if (lines.length === 0) return "(empty tool result)";
  return lines.join("\n\n");
}

export const MCP_ELICITATION_UNAVAILABLE =
  "MCP server requires user input (elicitation); elicitation handler not ready.";

export const MCP_URL_ELICITATION_REQUIRED_CODE = -32042;
