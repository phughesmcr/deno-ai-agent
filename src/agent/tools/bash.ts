import type { Tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { grantBrokerRunForCommands } from "../../permission-broker/mod.ts";
import type { ApprovalRequest } from "../../shared/approval.ts";
import { logDebug } from "../../shared/mod.ts";
import { requestForOperation } from "./approval-support.ts";
import type { ToolContext } from "./context.ts";
import { type AgentToolDefinition, type AgentToolDeps, toolFromDefinition } from "./definitions.ts";
import { getShellCommand } from "./shell-command.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

const bashParameters = {
  command: z.string().describe("Shell command to execute"),
  timeout: z.number().optional().describe("Timeout in seconds (optional)"),
  is_background: z.boolean().optional().describe("Start the command in the background and return immediately"),
} as const;

export const bashToolDefinition: AgentToolDefinition<typeof bashParameters> = {
  name: "bash",
  description:
    `Execute a bash command in the workspace directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${
      DEFAULT_MAX_BYTES / 1024
    }KB (whichever is hit first). Optionally provide a timeout in seconds, or is_background=true for long-running commands. For reading files outside the workspace (e.g. ~/.codex/...), use the read tool with a ~/ path instead of bash.`,
  parameters: bashParameters,
  authorize: ({ command }, deps): ApprovalRequest => {
    return requestForOperation(deps.workspace, {
      operation: "shell",
      target: command,
      risk: "high",
      summary: `cwd=${deps.workspace.root}`,
    });
  },
  run: async ({ command, timeout, is_background }, deps): Promise<string> => {
    const ctx = deps.workspace;
    const { cmd, args } = getShellCommand();
    await grantBrokerRunForCommands([cmd], ctx.signal);
    logDebug("shell.run_granted", {
      sessionId: ctx.getSessionId(),
      turnId: ctx.getTurnId(),
      shell: cmd,
    });
    const timeoutController = new AbortController();
    const timeoutMs = timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
    }
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutController.signal]) : timeoutController.signal;

    try {
      const started = performance.now();
      logDebug("shell.spawn", {
        sessionId: ctx.getSessionId(),
        turnId: ctx.getTurnId(),
        shell: cmd,
        cwd: ctx.root,
        background: String(Boolean(is_background)),
      });

      if (is_background) {
        const child = new Deno.Command(cmd, {
          args: [...args, command],
          cwd: ctx.root,
          stdout: "null",
          stderr: "null",
          env: { NO_COLOR: "1", TERM: "dumb" },
        }).spawn();
        child.unref();
        logDebug("shell.started_background", {
          sessionId: ctx.getSessionId(),
          turnId: ctx.getTurnId(),
          shell: cmd,
          pid: String(child.pid),
          durationMs: String(Math.round(performance.now() - started)),
        });
        return `Started background command with PID ${child.pid}.`;
      }

      const child = new Deno.Command(cmd, {
        args: [...args, command],
        cwd: ctx.root,
        stdout: "piped",
        stderr: "piped",
        env: { NO_COLOR: "1", TERM: "dumb" },
        signal,
      }).spawn();

      const [stdout, stderr, status] = await Promise.all([
        readStream(child.stdout),
        readStream(child.stderr),
        child.status,
      ]);
      if (signal.aborted) throw new Error("Command aborted");
      logDebug("shell.completed", {
        sessionId: ctx.getSessionId(),
        turnId: ctx.getTurnId(),
        shell: cmd,
        code: String(status.code),
        success: String(status.success),
        durationMs: String(Math.round(performance.now() - started)),
        stdoutBytes: String(stdout.length),
        stderrBytes: String(stderr.length),
      });

      let output = [stdout, stderr].filter((s) => s.length > 0).join(
        stdout.length > 0 && stderr.length > 0 ? "\n" : "",
      );
      if (!output) output = "(no output)";

      const truncation = truncateTail(output);
      let text = truncation.content;
      if (truncation.truncated) {
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;
        if (truncation.truncatedBy === "lines") {
          text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Output truncated.]`;
        } else {
          text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${
            formatSize(DEFAULT_MAX_BYTES)
          } limit). Output truncated.]`;
        }
      }

      if (!status.success) {
        const code = status.code;
        throw new Error(text ? `${text}\n\nCommand exited with code ${code}` : `Command exited with code ${code}`);
      }

      return text;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Command aborted");
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  },
};

export function createBashTool(ctx: ToolContext): Tool {
  return toolFromDefinition(bashToolDefinition, { workspace: ctx } as AgentToolDeps);
}
