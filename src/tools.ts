import { type Tool, tool } from "@lmstudio/sdk";
import { z } from "zod/v3";

/** Manages LM Studio tool definitions available to the model. */
export class ToolsManager {
  /** @internal */
  readonly tools: Tool[] = [
    tool({
      name: "multiply",
      description: "Given two numbers a and b. Returns the product of them.",
      parameters: { a: z.number(), b: z.number() },
      implementation: ({ a, b }) => a * b,
    }),
  ];

  /** @internal */
  get(): Tool[] | undefined;
  /** @internal */
  get(name: string): Tool | undefined;
  /** @internal */
  get(name?: string): Tool[] | Tool | undefined {
    if (name) {
      return this.tools.find((tool) => tool.name === name);
    }
    return [...this.tools];
  }
}
