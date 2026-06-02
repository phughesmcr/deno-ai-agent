import * as path from "@std/path";
import { assertEquals } from "jsr:@std/assert@1";
import { formatControlMessage, parseControlMessage } from "../../src/permission-broker/control-protocol.ts";
import { type BrokerDaemonEnv, PermissionBrokerDaemon } from "../../src/permission-broker/daemon.ts";
import { readJsonlLine, writeJsonlLine } from "../../src/permission-broker/jsonl.ts";

function integrationEnabled(): boolean {
  try {
    return Deno.env.get("DENO_TEST_PERMISSION_BROKER") === "1";
  } catch {
    return false;
  }
}

async function startDaemon(env: BrokerDaemonEnv): Promise<{ controller: AbortController; done: Promise<void> }> {
  const controller = new AbortController();
  const daemon = new PermissionBrokerDaemon(env);
  const done = daemon.run(controller.signal).catch(() => {});
  await waitForSocket(env.brokerPath);
  await waitForSocket(env.controlPath);
  return { controller, done };
}

async function makeEnv(runPrompts: boolean): Promise<{
  env: BrokerDaemonEnv;
  controller: AbortController;
  done: Promise<void>;
}> {
  const root = await Deno.makeTempDir({ dir: Deno.cwd(), prefix: ".silas-broker-test-" });
  const workspace = path.join(root, "ws");
  const project = path.join(root, "project");
  await Deno.mkdir(path.join(workspace, "a"), { recursive: true });
  await Deno.mkdir(path.join(project, "src"), { recursive: true });
  await Deno.writeTextFile(path.join(workspace, "a", "f.txt"), "x");
  await Deno.writeTextFile(path.join(project, "src", "secret.ts"), "x");

  const env: BrokerDaemonEnv = {
    brokerPath: path.join(root, "broker.sock"),
    controlPath: path.join(root, "control.sock"),
    workspacePath: workspace,
    projectRoot: project,
    denoDir: path.join(root, "deno-cache"),
    promptTimeoutMs: 5000,
    runPromptsEnabled: runPrompts,
  };
  const { controller, done } = await startDaemon(env);
  return { env, controller, done };
}

Deno.test({
  name: "broker daemon allows workspace and project src read without control",
  ignore: !integrationEnabled(),
}, async () => {
  const { env, controller, done } = await makeEnv(false);

  const brokerConn = await Deno.connect({ transport: "unix", path: env.brokerPath });
  try {
    const allowLine = JSON.stringify({
      v: 1,
      pid: 1,
      id: 1,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "read",
      value: path.join(env.workspacePath, "a", "f.txt"),
    });
    await writeJsonlLine(brokerConn, allowLine);
    const allowResp = await readJsonlLine(brokerConn);
    assertEquals(JSON.parse(allowResp!).result, "allow");

    const srcReadLine = JSON.stringify({
      v: 1,
      pid: 1,
      id: 2,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "read",
      value: path.join(env.projectRoot, "src", "secret.ts"),
    });
    await writeJsonlLine(brokerConn, srcReadLine);
    const srcReadResp = await readJsonlLine(brokerConn);
    assertEquals(JSON.parse(srcReadResp!).result, "allow");

    const srcWriteLine = JSON.stringify({
      v: 1,
      pid: 1,
      id: 3,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "write",
      value: path.join(env.projectRoot, "src", "secret.ts"),
    });
    await writeJsonlLine(brokerConn, srcWriteLine);
    const srcWriteResp = await readJsonlLine(brokerConn);
    assertEquals(JSON.parse(srcWriteResp!).result, "deny");
  } finally {
    brokerConn.close();
    controller.abort();
    await done;
  }
});

Deno.test({
  name: "broker daemon prompts via control socket",
  ignore: !integrationEnabled(),
}, async () => {
  const { env, controller, done } = await makeEnv(true);

  const controlConn = await Deno.connect({ transport: "unix", path: env.controlPath });
  const brokerConn = await Deno.connect({ transport: "unix", path: env.brokerPath });

  try {
    await writeJsonlLine(controlConn, formatControlMessage({ type: "register", pid: 42 }));
    await new Promise((r) => setTimeout(r, 20));

    const runLine = JSON.stringify({
      v: 1,
      pid: 1,
      id: 10,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "run",
      value: "/bin/sh",
    });
    await writeJsonlLine(brokerConn, runLine);

    const promptLine = await readJsonlLine(controlConn);
    assertEquals(parseControlMessage(promptLine!).type, "prompt");
    const prompt = parseControlMessage(promptLine!);
    if (prompt.type !== "prompt") throw new Error("expected prompt");

    await writeJsonlLine(
      controlConn,
      formatControlMessage({
        type: "decision",
        requestId: prompt.requestId,
        result: "allow",
        grant: "once",
      }),
    );

    const runResp = await readJsonlLine(brokerConn);
    assertEquals(JSON.parse(runResp!).result, "allow");
  } finally {
    controlConn.close();
    brokerConn.close();
    controller.abort();
    await done;
  }
});

async function waitForSocket(sockPath: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await Deno.stat(sockPath);
      return;
    } catch {
      /* socket not created yet */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`socket not ready: ${sockPath}`);
}
