import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { approveToolOperation, type ToolContext } from "./context.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

function getShellCommand(): { cmd: string; args: string[] } {
  if (Deno.build.os === "windows") {
    return { cmd: "cmd.exe", args: ["/c"] };
  }
  try {
    const shell = Deno.env.get("SHELL");
    if (shell) {
      const name = shell.split("/").pop() ?? "sh";
      if (name === "bash" || name === "zsh" || name === "sh") {
        return { cmd: shell, args: ["-c"] };
      }
    }
  } catch {
    // Deno.env may be unavailable under restricted permissions.
  }
  return { cmd: "/bin/sh", args: ["-c"] };
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

export function createBashTool(ctx: ToolContext): unknown {
  return tool({
    name: "bash",
    description:
      `Execute a bash command in the workspace directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${
        DEFAULT_MAX_BYTES / 1024
      }KB (whichever is hit first). Optionally provide a timeout in seconds.`,
    parameters: {
      command: z.string().describe("Shell command to execute"),
      timeout: z.number().optional().describe("Timeout in seconds (optional)"),
    },
    implementation: async ({ command, timeout }) => {
      await approveToolOperation(ctx, {
        operation: "shell",
        target: command,
        risk: "high",
        summary: `cwd=${ctx.root}`,
      });

      const { cmd, args } = getShellCommand();
      const abortController = new AbortController();
      const timeoutMs = timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs !== undefined) {
        timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
      }

      try {
        const child = new Deno.Command(cmd, {
          args: [...args, command],
          cwd: ctx.root,
          stdout: "piped",
          stderr: "piped",
          env: { NO_COLOR: "1", TERM: "dumb" },
          signal: abortController.signal,
        }).spawn();

        const [stdout, stderr, status] = await Promise.all([
          readStream(child.stdout),
          readStream(child.stderr),
          child.status,
        ]);

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
