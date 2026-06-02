import * as path from "@std/path";
import { assertEquals } from "jsr:@std/assert@1";
import { BOOTSTRAP_ENV_VARS } from "../../src/permission-broker/bootstrap-fixtures.ts";
import { createPolicyContext, decidePolicy, effectiveDecision } from "../../src/permission-broker/policy.ts";
import type { BrokerRequest } from "../../src/permission-broker/protocol.ts";
import { SessionCache } from "../../src/permission-broker/session-cache.ts";

function request(permission: string, value: string | null, id = 1): BrokerRequest {
  return {
    v: 1,
    pid: 1,
    id,
    datetime: "2025-01-01T00:00:00.000Z",
    permission,
    value,
  };
}

async function makeFixture(): Promise<{
  workspace: string;
  project: string;
  src: string;
  denoDir: string;
}> {
  const root = await Deno.makeTempDir();
  const workspace = path.join(root, "workspace");
  const project = path.join(root, "project");
  const src = path.join(project, "src");
  await Deno.mkdir(path.join(workspace, "nested"), { recursive: true });
  await Deno.mkdir(src, { recursive: true });
  await Deno.writeTextFile(path.join(workspace, "nested", "a.txt"), "ok");
  return { workspace, project, src, denoDir: path.join(root, "deno-cache") };
}

function ctx(
  fixture: { workspace: string; project: string; denoDir: string },
  registered: boolean,
  runPrompts = false,
  cache = new SessionCache(),
): ReturnType<typeof createPolicyContext> {
  return createPolicyContext({
    workspaceRoot: fixture.workspace,
    projectRoot: fixture.project,
    denoDir: fixture.denoDir,
    runPromptsEnabled: runPrompts,
    controlRegistered: registered,
    cache,
  });
}

Deno.test("policy allows read inside workspace", async () => {
  const fixture = await makeFixture();
  const file = path.join(fixture.workspace, "nested", "a.txt");
  assertEquals(decidePolicy(request("read", file), ctx(fixture, true)), "auto_allow");
});

Deno.test("policy denies read under repo src", async () => {
  const fixture = await makeFixture();
  const file = path.join(fixture.src, "main.ts");
  assertEquals(decidePolicy(request("read", file), ctx(fixture, true)), "auto_deny");
});

Deno.test("policy denies run when prompts disabled", async () => {
  const fixture = await makeFixture();
  assertEquals(decidePolicy(request("run", "/bin/sh"), ctx(fixture, true, false)), "auto_deny");
});

Deno.test("policy prompts run when enabled", async () => {
  const fixture = await makeFixture();
  assertEquals(decidePolicy(request("run", "/bin/sh"), ctx(fixture, true, true)), "prompt");
});

Deno.test("policy allows bootstrap env vars", async () => {
  const fixture = await makeFixture();
  for (const name of BOOTSTRAP_ENV_VARS.slice(0, 3)) {
    assertEquals(decidePolicy(request("env", name), ctx(fixture, true)), "auto_allow");
  }
});

Deno.test("effectiveDecision denies prompt before register", async () => {
  const fixture = await makeFixture();
  assertEquals(effectiveDecision("prompt", ctx(fixture, false)), "auto_deny");
});

Deno.test("session cache allows subsequent run", async () => {
  const fixture = await makeFixture();
  const cache = new SessionCache();
  cache.grant("run", "/bin/sh", "session");
  assertEquals(decidePolicy(request("run", "/bin/sh"), ctx(fixture, true, true, cache)), "auto_allow");
});
