import { tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import type { ToolContext } from "./context.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

const DESCRIPTION =
  `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${
    DEFAULT_MAX_BYTES / 1024
  }KB (whichever is hit first). Optionally provide a timeout in seconds.`;

function getShell(): string {
  try {
    return Deno.env.get("SHELL") ?? "/bin/sh";
  } catch {
    return "/bin/sh";
  }
}

export function createBashTool(ctx: ToolContext): ReturnType<typeof tool> {
  return tool({
    name: "bash",
    description: DESCRIPTION,
    parameters: {
      command: z.string().describe("Bash command to execute"),
      timeout: z.number().optional().describe("Timeout in seconds (optional, no default timeout)"),
    },
    implementation: async ({ command, timeout }) => {
      const shell = getShell();
      try {
        await Deno.stat(ctx.root);
      } catch {
        throw new Error(`Working directory does not exist: ${ctx.root}\nCannot execute bash commands.`);
      }

      const cmd = new Deno.Command(shell, {
        args: ["-c", command],
        cwd: ctx.root,
        stdout: "piped",
        stderr: "piped",
      });

      const child = cmd.spawn();
      const outputPromise = child.output();
      let output: Deno.CommandOutput;
      try {
        if (timeout !== undefined && timeout > 0) {
          output = await Promise.race([
            outputPromise,
            new Promise<Deno.CommandOutput>((_, reject) => {
              setTimeout(() => {
                child.kill("SIGTERM");
                reject(new Error(`Command timed out after ${timeout} seconds`));
              }, timeout * 1000);
            }),
          ]);
        } else {
          output = await outputPromise;
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Command timed out")) throw error;
        throw error;
      }

      const combined = new TextDecoder().decode(output.stdout) + new TextDecoder().decode(output.stderr);
      const truncation = truncateTail(combined);

      let outputText = truncation.content || "(no output)";
      if (truncation.truncated) {
        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;
        if (truncation.lastLinePartial) {
          outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line truncated).]`;
        } else if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${
            formatSize(DEFAULT_MAX_BYTES)
          } limit).]`;
        }
      }

      if (!output.success) {
        const code = output.code;
        throw new Error(
          outputText ? `${outputText}\n\nCommand exited with code ${code}` : `Command exited with code ${code}`,
        );
      }

      return outputText;
    },
  });
}
