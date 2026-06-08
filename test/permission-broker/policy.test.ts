import * as path from "@std/path";
import { assertEquals } from "jsr:@std/assert@1";
import { BOOTSTRAP_ENV_VARS } from "../../src/permission-broker/bootstrap-fixtures.ts";
import { createPolicyContext, decidePolicy } from "../../src/permission-broker/policy.ts";
import type { BrokerRequest } from "../../src/permission-broker/protocol.ts";

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
  runPrompts = false,
): ReturnType<typeof createPolicyContext> {
  return createPolicyContext({
    workspaceRoot: fixture.workspace,
    projectRoot: fixture.project,
    denoDir: fixture.denoDir,
    runPromptsEnabled: runPrompts,
  });
}

Deno.test("policy allows read inside workspace", async () => {
  const fixture = await makeFixture();
  const file = path.join(fixture.workspace, "nested", "a.txt");
  assertEquals(decidePolicy(request("read", file), ctx(fixture)), "auto_allow");
});

Deno.test("policy allows read under repo src for app startup", async () => {
  const fixture = await makeFixture();
  const file = path.join(fixture.src, "main.ts");
  assertEquals(decidePolicy(request("read", file), ctx(fixture)), "auto_allow");
});

Deno.test("policy denies write under repo src", async () => {
  const fixture = await makeFixture();
  const file = path.join(fixture.src, "main.ts");
  assertEquals(decidePolicy(request("write", file), ctx(fixture)), "auto_deny");
});

Deno.test("policy denies repo src writes even when workspace is the project root", async () => {
  const fixture = await makeFixture();
  const file = path.join(fixture.src, "main.ts");
  const context = createPolicyContext({
    workspaceRoot: fixture.project,
    projectRoot: fixture.project,
    denoDir: fixture.denoDir,
    runPromptsEnabled: true,
  });

  assertEquals(decidePolicy(request("write", file), context), "auto_deny");
});

Deno.test("policy prompts read under home directory", async () => {
  const fixture = await makeFixture();
  const file = "/Users/tester/.codex/config.toml";
  assertEquals(decidePolicy(request("read", file), ctx(fixture)), "prompt");
});

Deno.test("policy denies run when prompts disabled", async () => {
  const fixture = await makeFixture();
  assertEquals(decidePolicy(request("run", "/bin/sh"), ctx(fixture, false)), "auto_deny");
});

Deno.test("policy prompts run when enabled", async () => {
  const fixture = await makeFixture();
  assertEquals(decidePolicy(request("run", "/bin/sh"), ctx(fixture, true)), "prompt");
});

Deno.test("policy allows bootstrap env vars", async () => {
  const fixture = await makeFixture();
  for (const name of BOOTSTRAP_ENV_VARS.slice(0, 3)) {
    assertEquals(decidePolicy(request("env", name), ctx(fixture)), "auto_allow");
  }
});

Deno.test("policy allows terminal color env vars needed by npm packages", async () => {
  const fixture = await makeFixture();
  for (const name of ["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM", "FORCE_COLOR", "NO_COLOR"]) {
    assertEquals(decidePolicy(request("env", name), ctx(fixture)), "auto_allow");
  }
});

Deno.test("policy allows env enumeration needed by Node compatibility shims", async () => {
  const fixture = await makeFixture();
  assertEquals(decidePolicy(request("env", null), ctx(fixture)), "auto_allow");
});

Deno.test("policy allows unknown env keys after Node env enumeration", async () => {
  const fixture = await makeFixture();
  assertEquals(decidePolicy(request("env", "__SHELL_INHERITED_KEY__"), ctx(fixture)), "auto_allow");
});

Deno.test("policy allows broker control socket before registration", async () => {
  const fixture = await makeFixture();
  const context = createPolicyContext({
    workspaceRoot: fixture.workspace,
    projectRoot: fixture.project,
    denoDir: fixture.denoDir,
    brokerSocketPaths: ["/tmp/silas-perm.sock", "/tmp/silas-perm-control.sock"],
    runPromptsEnabled: true,
  });

  assertEquals(decidePolicy(request("read", "/tmp/silas-perm-control.sock"), context), "auto_allow");
  assertEquals(decidePolicy(request("net", "/tmp/silas-perm-control.sock"), context), "auto_allow");
});
