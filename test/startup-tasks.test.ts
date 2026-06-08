import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

function documentedDenoTaskNames(markdown: string): string[] {
  return [...markdown.matchAll(/\bdeno task ([a-zA-Z0-9:_-]+)/g)].map((match) => match[1]!);
}

Deno.test("startup tasks make broker mode the default and unsafe mode explicit", async () => {
  const denoConfig = JSON.parse(await Deno.readTextFile("deno.json")) as {
    tasks: Record<string, string>;
  };

  assertEquals(denoConfig.tasks["start"], "bash scripts/start-with-broker.sh");
  assertEquals(denoConfig.tasks["start:otel"], "bash scripts/start-with-broker-otel.sh");
  assertEquals(
    denoConfig.tasks["start:otel:console"],
    "OTEL_EXPORTER_OTLP_PROTOCOL=console bash scripts/start-with-broker-otel.sh",
  );
  assertEquals(denoConfig.tasks["start:unsafe"], "bash scripts/start-unsafe.sh");
  assertStringIncludes(denoConfig.tasks["start:unsafe:otel"] ?? "", "bash scripts/start-unsafe.sh");
  assert(!("start:broker" in denoConfig.tasks));

  const startScript = await Deno.readTextFile("scripts/start-with-broker.sh");
  const agentScript = await Deno.readTextFile("scripts/start-agent-with-broker.sh");
  const otelAgentScript = await Deno.readTextFile("scripts/start-agent-with-broker-otel.sh");
  const unsafeScript = await Deno.readTextFile("scripts/start-unsafe.sh");
  assertStringIncludes(startScript, "deno task agent:broker");
  assert(!agentScript.includes(" -A "));
  assert(!otelAgentScript.includes("source .env"));
  assertStringIncludes(otelAgentScript, "awk");
  assertStringIncludes(otelAgentScript, "(OTEL_DENO|OTEL_SERVICE_NAME)=");
  assertStringIncludes(otelAgentScript, '--env-file="$OTEL_ENV"');
  assertStringIncludes(unsafeScript, "DENO_PERMISSION_BROKER_PATH");
  assertStringIncludes(unsafeScript, "SILAS_PERMISSION_CONTROL_PATH");
  assertStringIncludes(unsafeScript, "--allow-run");
  assertStringIncludes(unsafeScript, "--allow-net");
});

Deno.test("documented deno tasks exist in deno.json", async () => {
  const denoConfig = JSON.parse(await Deno.readTextFile("deno.json")) as {
    tasks: Record<string, string>;
  };
  const docs = [
    "README.md",
    "src/permission-broker/README.md",
    "otel/README.md",
  ];
  const missing: string[] = [];

  for (const docPath of docs) {
    const taskNames = documentedDenoTaskNames(await Deno.readTextFile(docPath));
    for (const taskName of taskNames) {
      if (!(taskName in denoConfig.tasks)) missing.push(`${docPath}: ${taskName}`);
    }
  }

  assertEquals(missing, []);
});

Deno.test("broker-env reads broker keys from env file without shell-sourcing it", async () => {
  const tempDir = await Deno.makeTempDir({ dir: Deno.cwd(), prefix: ".silas-broker-env-test-" });
  try {
    const envPath = `${tempDir}/agent.env`;
    await Deno.writeTextFile(
      envPath,
      [
        "SILAS_BROKER_LISTEN_PATH=/tmp/custom-broker.sock",
        "SILAS_PERMISSION_CONTROL_PATH=/tmp/custom-control.sock",
        "SILAS_PERMISSION_RUN_PROMPTS=0",
        "SILAS_PROJECT_ROOT=/tmp/custom-root",
        "REASONING_START=<think>",
        "UNUSED_SHELL=$(echo should-not-run)",
      ].join("\n"),
    );

    const command = new Deno.Command("bash", {
      args: [
        "-c",
        [
          "set -euo pipefail",
          'export SILAS_ENV_FILE="$1"',
          "unset SILAS_BROKER_LISTEN_PATH SILAS_PERMISSION_CONTROL_PATH DENO_PERMISSION_BROKER_PATH SILAS_PERMISSION_RUN_PROMPTS SILAS_PROJECT_ROOT",
          "source scripts/broker-env.sh",
          'printf \'%s\\n\' "$SILAS_BROKER_LISTEN_PATH" "$SILAS_PERMISSION_CONTROL_PATH" "$DENO_PERMISSION_BROKER_PATH" "$SILAS_PERMISSION_RUN_PROMPTS" "$SILAS_PROJECT_ROOT" "${UNUSED_SHELL-unset}"',
        ].join("; "),
        "broker-env-test",
        envPath,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, stderr);
    assertEquals(new TextDecoder().decode(output.stdout).trimEnd().split("\n"), [
      "/tmp/custom-broker.sock",
      "/tmp/custom-control.sock",
      "/tmp/custom-broker.sock",
      "0",
      "/tmp/custom-root",
      "unset",
    ]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
