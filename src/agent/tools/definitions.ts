import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

import type {
  CapabilityDescriptor,
  CapabilityRequestDisplay,
  CapabilityRequestSource,
  CapabilityRisk,
} from "../../core/mod.ts";
import type { RuntimeToolDefinition, ToolDescriptor } from "../../core/tool-runtime.ts";
import type { SkillManager } from "../skills/mod.ts";
import type { SubagentPort } from "../subagents.ts";
import type { ToolContext } from "./context.ts";
import type { TodoWriteDeps } from "./todo-write.ts";
import { withRecoverableToolErrors } from "./tool-errors.ts";
import type { UserInteractionPort } from "./user-question-port.ts";

/** Pi-aligned tool identifiers registered with the model. */
export type ToolName =
  | "read"
  | "write"
  | "edit"
  | "bash"
  | "typescript-repl"
  | "grep"
  | "find"
  | "ls"
  | "skill"
  | "todo_write"
  | "web-fetch"
  | "ask_user_question"
  | "subagent";

/** All local tool names in registration order. */
export const allToolNames: ToolName[] = [
  "read",
  "write",
  "edit",
  "bash",
  "typescript-repl",
  "grep",
  "find",
  "ls",
  "skill",
  "todo_write",
  "web-fetch",
  "ask_user_question",
  "subagent",
];

export type ToolParams<TShape extends z.ZodRawShape> = z.infer<z.ZodObject<TShape>>;

export interface AgentToolDeps {
  workspace: ToolContext;
  userQuestions: UserInteractionPort;
  todos: TodoWriteDeps;
  skills: {
    manager: SkillManager;
    getSessionId: () => string;
  };
  subagents: SubagentPort;
  mcp?: { getTools(): Tool[] };
}

/** Capability request data produced by a validated tool call before per-turn ids are attached. */
export interface AgentToolCapabilityRequestSpec {
  /** Capability being requested. */
  capability: CapabilityDescriptor;
  /** Source adapter for the capability. */
  source: CapabilityRequestSource;
  /** Coarse user-facing risk. */
  risk: CapabilityRisk;
  /** Short operation summary that avoids file contents and secrets. */
  summary?: string;
  /** Deny automatically after this many milliseconds. */
  timeoutMs: number;
  /** Display metadata for prompt adapters. */
  display: CapabilityRequestDisplay;
}

export interface AgentToolDefinition<TShape extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: ToolName;
  readonly description: string | ((deps: AgentToolDeps) => string);
  readonly parameters: TShape;
  authorize(
    params: ToolParams<TShape>,
    deps: AgentToolDeps,
  ): AgentToolCapabilityRequestSpec | null | Promise<AgentToolCapabilityRequestSpec | null>;
  run(
    params: ToolParams<TShape>,
    deps: AgentToolDeps,
  ): string | Promise<string>;
}

export type AgentRuntimeToolDefinition<TShape extends z.ZodRawShape = z.ZodRawShape> = RuntimeToolDefinition<
  AgentToolDeps,
  ToolParams<TShape>,
  AgentToolCapabilityRequestSpec,
  string
>;

export function parseToolParams<TShape extends z.ZodRawShape>(
  definition: AgentToolDefinition<TShape>,
  raw: Record<string, unknown> | undefined,
): ToolParams<TShape> {
  return z.object(definition.parameters).parse(raw ?? {});
}

export function runtimeToolFromDefinition<TShape extends z.ZodRawShape>(
  definition: AgentToolDefinition<TShape>,
): AgentRuntimeToolDefinition<TShape> {
  return {
    name: definition.name,
    describe(deps: AgentToolDeps): ToolDescriptor {
      const description = typeof definition.description === "function" ?
        definition.description(deps) :
        definition.description;
      return {
        name: definition.name,
        description,
        parameters: definition.parameters,
      };
    },
    parse(raw: Record<string, unknown> | undefined): ToolParams<TShape> {
      return parseToolParams(definition, raw);
    },
    authorize(
      params: ToolParams<TShape>,
      deps: AgentToolDeps,
    ): AgentToolCapabilityRequestSpec | null | Promise<AgentToolCapabilityRequestSpec | null> {
      return definition.authorize(params, deps);
    },
    execute(params: ToolParams<TShape>, deps: AgentToolDeps): string | Promise<string> {
      return definition.run(params, deps);
    },
  };
}

export function toolFromRuntimeDefinition(
  runtimeTool: AgentRuntimeToolDefinition,
  deps: AgentToolDeps,
): Tool {
  const descriptor = runtimeTool.describe(deps);
  return withRecoverableToolErrors(
    tool({
      name: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters as z.ZodRawShape,
      implementation: (raw) => runtimeTool.execute(runtimeTool.parse(raw), deps),
    }),
  );
}

export function toolFromDefinition<TShape extends z.ZodRawShape>(
  definition: AgentToolDefinition<TShape>,
  deps: AgentToolDeps,
): Tool {
  return toolFromRuntimeDefinition(runtimeToolFromDefinition(definition), deps);
}
