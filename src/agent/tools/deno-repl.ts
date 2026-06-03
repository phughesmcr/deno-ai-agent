import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { approveToolOperation, type ToolContext } from "./context.ts";
import { readStreamToString } from "./search-support.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

const DEFAULT_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 60;

export interface DenoReplToolParams {
  javascript: string;
  timeout?: number;
}

function validateTimeoutSeconds(timeout: number | undefined): number {
  const seconds = timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Parameter "timeout" must be greater than 0 seconds.`);
  }
  if (seconds > MAX_TIMEOUT_SECONDS) {
    throw new Error(`Parameter "timeout" must be no more than ${MAX_TIMEOUT_SECONDS} seconds.`);
  }
  return seconds;
}

function formatOutput(stdout: string, stderr: string): string {
  const trimmedStdout = stdout.trimEnd();
  const trimmedStderr = stderr.trimEnd();
  if (!trimmedStdout && !trimmedStderr) return "(no output)";
  if (!trimmedStdout) return trimmedStderr;
  if (!trimmedStderr) return trimmedStdout;
  return `${trimmedStdout}\n${trimmedStderr}`;
}

function formatTruncatedOutput(output: string): string {
  const truncation = truncateTail(output);
  let text = truncation.content;
  if (!truncation.truncated) return text;

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Output truncated.]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${
      formatSize(DEFAULT_MAX_BYTES)
    } limit). Output truncated.]`;
  }
  return text;
}

function abortErrorMessage(timeoutSignal: AbortSignal): string {
  if (timeoutSignal.aborted) {
    return "JavaScript execution timed out";
  }
  return "JavaScript execution aborted";
}

export function createDenoReplTool(ctx: ToolContext): Tool {
  return tool({
    name: "deno_repl",
    description:
      `Run a JavaScript or TypeScript snippet with Deno in the workspace directory. The snippet can read and write workspace files, but cannot access the network, environment, subprocesses, FFI, or system APIs. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${
        DEFAULT_MAX_BYTES / 1024
      }KB (whichever is hit first). Optionally provide a timeout in seconds, up to ${MAX_TIMEOUT_SECONDS}.`,
    parameters: {
      javascript: z.string().describe("JavaScript or TypeScript code to execute"),
      timeout: z.number().optional().describe(`Timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})`),
    },
    implementation: async ({ javascript, timeout }: DenoReplToolParams) => {
      const timeoutSeconds = validateTimeoutSeconds(timeout);
      await approveToolOperation(ctx, {
        operation: "shell",
        target: "deno_repl",
        risk: "high",
        summary: `run javascript, timeout=${timeoutSeconds}s, ${javascript.length} bytes`,
      });

      let scriptPath: string | undefined;
      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), timeoutSeconds * 1000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutController.signal]) : timeoutController.signal;

      try {
        scriptPath = await Deno.makeTempFile({
          dir: ctx.root,
          prefix: ".silas-deno-repl-",
          suffix: ".ts",
        });
        await Deno.writeTextFile(scriptPath, javascript);

        const child = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--no-config",
            "--no-remote",
            "--allow-read=.",
            "--allow-write=.",
            "--no-prompt",
            "--deny-net",
            "--deny-env",
            "--deny-sys",
            "--deny-run",
            "--deny-ffi",
            scriptPath,
          ],
          cwd: ctx.root,
          stdout: "piped",
          stderr: "piped",
          env: { NO_COLOR: "1", TERM: "dumb" },
          signal,
        }).spawn();

        const [stdout, stderr, status] = await Promise.all([
          readStreamToString(child.stdout),
          readStreamToString(child.stderr),
          child.status,
        ]);
        if (signal.aborted) throw new Error(abortErrorMessage(timeoutController.signal));

        const output = formatOutput(stdout, stderr);
        const text = formatTruncatedOutput(output);
        if (!status.success) {
          throw new Error(`${text}\n\nJavaScript exited with code ${status.code}`);
        }
        return text;
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new Error(abortErrorMessage(timeoutController.signal));
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
        if (scriptPath !== undefined) {
          try {
            await Deno.remove(scriptPath);
          } catch {
            // Best-effort cleanup must not hide the execution result.
          }
        }
      }
    },
  });
}
