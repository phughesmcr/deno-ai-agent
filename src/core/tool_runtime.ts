/** Public metadata for a tool exposed to a model or adapter. */
export interface ToolDescriptor {
  /** Stable tool name. */
  name: string;
  /** Human-readable tool description. */
  description: string;
  /** Adapter-specific parameter schema. */
  parameters: unknown;
}

/** Core tool runtime interface: describe, authorize, execute. */
export interface RuntimeToolDefinition<TDeps = unknown, TParams = unknown, TAuth = unknown, TResult = unknown> {
  /** Stable tool name. */
  readonly name: string;
  /** Returns adapter-facing metadata for this tool. */
  describe(deps: TDeps): ToolDescriptor;
  /** Parses and validates raw model parameters. */
  parse(raw: Record<string, unknown> | undefined): TParams;
  /** Returns an authorization request/decision payload when execution is not automatically allowed. */
  authorize(params: TParams, deps: TDeps): TAuth | null | Promise<TAuth | null>;
  /** Executes the tool after authorization has been resolved. */
  execute(params: TParams, deps: TDeps): TResult | Promise<TResult>;
}

/** Runtime-level tool lookup and invocation boundary. */
export class ToolRuntime<TDeps = unknown, TAuth = unknown, TResult = unknown> {
  private readonly _definitions: Map<string, RuntimeToolDefinition<TDeps, unknown, TAuth, TResult>>;

  /** Creates a runtime over a fixed set of tool definitions. */
  constructor(definitions: readonly RuntimeToolDefinition<TDeps, unknown, TAuth, TResult>[]) {
    this._definitions = new Map();
    for (const definition of definitions) {
      if (this._definitions.has(definition.name)) throw new Error(`Duplicate tool definition: ${definition.name}`);
      this._definitions.set(definition.name, definition);
    }
  }

  /** Lists tool names in registration order. */
  names(): string[] {
    return [...this._definitions.keys()];
  }

  /** Returns the registered tool, or undefined when missing. */
  get(name: string): RuntimeToolDefinition<TDeps, unknown, TAuth, TResult> | undefined {
    return this._definitions.get(name);
  }

  /** Lists descriptors for all registered tools. */
  describeAll(deps: TDeps): ToolDescriptor[] {
    return [...this._definitions.values()].map((definition) => definition.describe(deps));
  }

  /** Parses and authorizes one tool call by name. */
  async authorize(name: string, raw: Record<string, unknown> | undefined, deps: TDeps): Promise<TAuth | null> {
    const definition = this._require(name);
    const params = definition.parse(raw);
    return await definition.authorize(params, deps);
  }

  /** Parses and executes one tool call by name. */
  async execute(name: string, raw: Record<string, unknown> | undefined, deps: TDeps): Promise<TResult> {
    const definition = this._require(name);
    const params = definition.parse(raw);
    return await definition.execute(params, deps);
  }

  /** Returns a registered definition or throws a stable missing-tool error. */
  private _require(name: string): RuntimeToolDefinition<TDeps, unknown, TAuth, TResult> {
    const definition = this._definitions.get(name);
    if (!definition) throw new Error(`Unknown tool: ${name}`);
    return definition;
  }
}
