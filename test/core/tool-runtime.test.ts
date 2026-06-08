import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";

import { type RuntimeToolDefinition, ToolRuntime } from "../../src/core/mod.ts";

interface Deps {
  prefix: string;
}

interface Params {
  value: string;
}

function echoTool(): RuntimeToolDefinition<Deps, Params, string, string> {
  return {
    name: "echo",
    describe: (deps) => ({
      name: "echo",
      description: `${deps.prefix} echo`,
      parameters: { value: "string" },
    }),
    parse(raw): Params {
      return { value: String(raw?.["value"] ?? "") };
    },
    authorize(params, deps): string {
      return `${deps.prefix}:${params.value}`;
    },
    execute(params, deps): string {
      return `${deps.prefix} ${params.value}`;
    },
  };
}

Deno.test("ToolRuntime describes, authorizes, and executes registered tools", async () => {
  const runtime = new ToolRuntime<Deps, string, string>([echoTool()]);
  const deps = { prefix: "ok" };

  assertEquals(runtime.names(), ["echo"]);
  assertEquals(runtime.describeAll(deps), [{
    name: "echo",
    description: "ok echo",
    parameters: { value: "string" },
  }]);
  assertEquals(await runtime.authorize("echo", { value: "run" }, deps), "ok:run");
  assertEquals(await runtime.execute("echo", { value: "run" }, deps), "ok run");
});

Deno.test("ToolRuntime rejects duplicate and unknown tools", async () => {
  assertThrows(
    () => new ToolRuntime([echoTool(), echoTool()]),
    Error,
    "Duplicate tool definition: echo",
  );

  const runtime = new ToolRuntime<Deps, string, string>([echoTool()]);
  await assertRejects(
    () => runtime.execute("missing", {}, { prefix: "ok" }),
    Error,
    "Unknown tool: missing",
  );
});
