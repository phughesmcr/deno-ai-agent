import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

/** Manages LM Studio tool definitions available to the model. */
export class ToolsManager {
  /** An array of all tools. */
  readonly tools: Tool[] = [
    tool({
      name: "multiply",
      description: "Given two numbers a and b. Returns the product of them.",
      parameters: { a: z.number(), b: z.number() },
      implementation: ({ a, b }) => a * b,
    }),
  ];

  /** Returns an array of all tools. */
  get(): Tool[] | undefined;
  /** Returns a tool by name. */
  get(name: string): Tool | undefined;
  /** Returns a tool by name or an array of all tools. */
  get(name?: string): Tool[] | Tool | undefined {
    if (name) {
      return this.tools.find((tool) => tool.name === name);
    }
    return [...this.tools];
  }
}
