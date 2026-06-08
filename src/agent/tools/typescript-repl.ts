import type { Tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import { grantBrokerRunForCommands } from "../../permission-broker/mod.ts";
import { logDebug } from "../../shared/mod.ts";
import { requestForOperation } from "./approval-support.ts";
import type { ToolContext } from "./context.ts";
import {
  type AgentToolCapabilityRequestSpec,
  type AgentToolDefinition,
  type AgentToolDeps,
  toolFromDefinition,
} from "./definitions.ts";
import { readStreamToString } from "./search-support.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.ts";

const DEFAULT_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 60;

const typescriptReplParameters = {
  typescript: z.string().describe("TypeScript code to execute"),
  timeout: z.number().optional().describe(`Timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})`),
} as const;

export interface TypeScriptReplToolParams {
  typescript: string;
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
    return "TypeScript execution timed out";
  }
  return "TypeScript execution aborted";
}

export const typescriptReplToolDefinition: AgentToolDefinition<typeof typescriptReplParameters> = {
  name: "typescript-repl",
  description:
    `Run a TypeScript snippet with Deno in the workspace directory. The snippet can read and write workspace files, but cannot access the network, environment, subprocesses, FFI, or system APIs. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${
      DEFAULT_MAX_BYTES / 1024
    }KB (whichever is hit first). Optionally provide a timeout in seconds, up to ${MAX_TIMEOUT_SECONDS}.`,
  parameters: typescriptReplParameters,
  authorize: ({ typescript, timeout }, deps): AgentToolCapabilityRequestSpec => {
    const timeoutSeconds = timeout ?? DEFAULT_TIMEOUT_SECONDS;
    return requestForOperation(deps.workspace, {
      operation: "shell",
      target: "typescript-repl",
      risk: "high",
      summary: `run typescript, timeout=${timeoutSeconds}s, ${typescript.length} bytes`,
    });
  },
  run: async ({ typescript, timeout }: TypeScriptReplToolParams, deps): Promise<string> => {
    const ctx = deps.workspace;
    const timeoutSeconds = validateTimeoutSeconds(timeout);
    await grantBrokerRunForCommands([Deno.execPath()], ctx.signal);
    logDebug("typescript_repl.run_granted", {
      sessionId: ctx.getSessionId(),
      turnId: ctx.getTurnId(),
      executable: Deno.execPath(),
    });

    let scriptPath: string | undefined;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutSeconds * 1000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutController.signal]) : timeoutController.signal;

    try {
      scriptPath = await Deno.makeTempFile({
        dir: ctx.root,
        prefix: ".silas-typescript-repl-",
        suffix: ".ts",
      });
      await Deno.writeTextFile(scriptPath, typescript);

      const started = performance.now();
      logDebug("typescript_repl.spawn", {
        sessionId: ctx.getSessionId(),
        turnId: ctx.getTurnId(),
        executable: Deno.execPath(),
      });
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
      logDebug("typescript_repl.completed", {
        sessionId: ctx.getSessionId(),
        turnId: ctx.getTurnId(),
        code: String(status.code),
        success: String(status.success),
        durationMs: String(Math.round(performance.now() - started)),
        stdoutBytes: String(stdout.length),
        stderrBytes: String(stderr.length),
      });

      const output = formatOutput(stdout, stderr);
      const text = formatTruncatedOutput(output);
      if (!status.success) {
        throw new Error(`${text}\n\nTypeScript exited with code ${status.code}`);
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
};

export function createTypeScriptReplTool(ctx: ToolContext): Tool {
  return toolFromDefinition(typescriptReplToolDefinition, { workspace: ctx } as AgentToolDeps);
}
