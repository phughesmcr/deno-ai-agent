import type { Tool } from "@lmstudio/sdk";

import { UserQuestionAbortedError, UserQuestionDeclinedError } from "./user-interaction.ts";

type ToolWithImplementation = Tool & {
  implementation: (params: Record<string, unknown>, toolCtx: unknown) => Promise<string>;
};

function isNonRecoverableToolError(error: unknown): boolean {
  return error instanceof UserQuestionAbortedError ||
    error instanceof UserQuestionDeclinedError;
}

/**
 * Returns tool errors as result text so the model can recover instead of aborting the turn.
 * User-question aborts still propagate.
 */
export function withRecoverableToolErrors(tool: Tool): Tool {
  const wrapped = tool as ToolWithImplementation;
  const original = wrapped.implementation;
  wrapped.implementation = async (params, toolCtx) => {
    try {
      return await original(params, toolCtx);
    } catch (error) {
      if (isNonRecoverableToolError(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return `Error: ${message}`;
    }
  };
  return tool;
}
