import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

Deno.test("startup tasks make broker mode the default and unsafe mode explicit", async () => {
  const denoConfig = JSON.parse(await Deno.readTextFile("deno.json")) as {
    tasks: Record<string, string>;
  };

  assertEquals(denoConfig.tasks["start"], "bash scripts/start-with-broker.sh");
  assertEquals(denoConfig.tasks["start:otel"], "bash scripts/start-with-broker-otel.sh");
  assertStringIncludes(denoConfig.tasks["start:unsafe"] ?? "", "--allow-run");
  assertStringIncludes(denoConfig.tasks["start:unsafe"] ?? "", "--allow-net");
  assert(!("start:broker" in denoConfig.tasks));

  const startScript = await Deno.readTextFile("scripts/start-with-broker.sh");
  const agentScript = await Deno.readTextFile("scripts/start-agent-with-broker.sh");
  assertStringIncludes(startScript, "deno task agent:broker");
  assert(!agentScript.includes(" -A "));
});
