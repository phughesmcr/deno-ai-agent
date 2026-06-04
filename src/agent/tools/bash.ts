import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { grantBrokerRunForCommands } from "../../permission-broker/mod.ts";
import { logDebug } from "../../shared/mod.ts";
import type { ToolContext } from "./context.ts";
import { getShellCommand } from "./shell-command.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

export function createBashTool(ctx: ToolContext): Tool {
  return tool({
    name: "bash",
    description:
      `Execute a bash command in the workspace directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${
        DEFAULT_MAX_BYTES / 1024
      }KB (whichever is hit first). Optionally provide a timeout in seconds. For reading files outside the workspace (e.g. ~/.codex/...), use the read tool with a ~/ path instead of bash.`,
    parameters: {
      command: z.string().describe("Shell command to execute"),
      timeout: z.number().optional().describe("Timeout in seconds (optional)"),
    },
    implementation: async ({ command, timeout }) => {
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
        });
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
  });
}
