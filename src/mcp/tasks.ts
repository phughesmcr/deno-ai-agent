import type { Client } from "@modelcontextprotocol/sdk/client";

/**
 * Polls an MCP task until terminal or aborted (experimental tasks API).
 */
export async function pollMcpTaskUntilDone(
  client: Client,
  taskId: string,
  signal: AbortSignal,
  pollIntervalMs = 500,
): Promise<{ status: string; result?: unknown }> {
  const tasks = client.experimental?.tasks;
  if (!tasks) {
    return { status: "unsupported" };
  }

  while (!signal.aborted) {
    const task = await tasks.getTask(taskId);
    const state = task.status;
    if (state === "completed" || state === "failed" || state === "cancelled") {
      return { status: state, result: task };
    }
    if (state === "input_required") {
      return { status: state, result: task };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  try {
    await tasks.cancelTask(taskId);
  } catch { /* ignore */ }
  return { status: "cancelled" };
}
