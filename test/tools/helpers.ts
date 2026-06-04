import type { Tool } from "@lmstudio/sdk";

import { createToolContext, type ToolContext } from "../../src/agent/tools/context.ts";
import type { AskUserQuestionPort } from "../../src/agent/tools/user-question-port.ts";

export async function createTestWorkspace(): Promise<{ dir: string; ctx: ToolContext; cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "silas-tools-" });
  const ctx = await createToolContext(dir, {
    sessionId: "test-session",
    turnId: "test-turn",
  });
  return {
    dir,
    ctx,
    cleanup: async () => {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/** Alias for integration tests. */
export const withSandbox = async (
  fn: (ctx: ToolContext, dir: string) => Promise<void>,
): Promise<void> => {
  const { dir, ctx, cleanup } = await createTestWorkspace();
  try {
    await fn(ctx, dir);
  } finally {
    await cleanup();
  }
};

type ToolWithImplementation = Tool & {
  implementation: (params: Record<string, unknown>, toolCtx: unknown) => Promise<string>;
};

export async function runTool(tool: unknown, args: Record<string, unknown>): Promise<string> {
  const impl = (tool as ToolWithImplementation).implementation;
  return await impl(args, {});
}

export async function runToolImplementation(
  tool: unknown,
  args: Record<string, unknown>,
): Promise<string> {
  return await runTool(tool, args);
}

/** Mock port that immediately resolves with preset answers. */
export function createMockAskUserQuestionPort(
  answers: Record<string, string>,
): AskUserQuestionPort {
  return {
    isAvailable: () => true,
    isPending: () => false,
    setTurnContext: () => {},
    clearTurnContext: () => {},
    ask: () => Promise.resolve(answers),
  };
}

export async function runToolImplementationThrows(
  tool: unknown,
  args: Record<string, unknown>,
): Promise<Error> {
  let error: Error | undefined;
  try {
    await runTool(tool, args);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  if (!error) throw new Error("Expected tool to throw");
  return error;
}
