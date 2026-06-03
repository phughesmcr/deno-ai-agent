import * as path from "@std/path";
import { assertEquals } from "jsr:@std/assert@1";
import { formatControlMessage, parseControlMessage } from "../../src/permission-broker/control-protocol.ts";
import { type BrokerDaemonEnv, PermissionBrokerDaemon } from "../../src/permission-broker/daemon.ts";
import { JsonlConnection } from "../../src/permission-broker/jsonl.ts";

const encoder = new TextEncoder();

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
  let startupError: unknown;
  const done = daemon.run(controller.signal).catch((error: unknown) => {
    startupError = error;
    throw error;
  });
  done.catch(() => {});
  try {
    await waitForSocket(env.brokerPath, () => startupError);
    await waitForSocket(env.controlPath, () => startupError);
    return { controller, done };
  } catch (error) {
    controller.abort();
    try {
      await done;
    } catch {
      /* startup failure is rethrown below */
    }
    throw error;
  }
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
  try {
    const { controller, done } = await startDaemon(env);
    return { env, controller, done };
  } catch (error) {
    await cleanupEnv(env);
    throw error;
  }
}

Deno.test({
  name: "broker daemon allows workspace and project src read without control",
  ignore: !integrationEnabled(),
}, async () => {
  const { env, controller, done } = await makeEnv(false);

  const brokerConn = await Deno.connect({ transport: "unix", path: env.brokerPath });
  const brokerJsonl = new JsonlConnection(brokerConn);
  try {
    const allowLine = JSON.stringify({
      v: 1,
      pid: 1,
      id: 1,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "read",
      value: path.join(env.workspacePath, "a", "f.txt"),
    });
    await brokerJsonl.writeLine(allowLine);
    const allowResp = await brokerJsonl.readLine();
    assertEquals(JSON.parse(allowResp!).result, "allow");

    const srcReadLine = JSON.stringify({
      v: 1,
      pid: 1,
      id: 2,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "read",
      value: path.join(env.projectRoot, "src", "secret.ts"),
    });
    await brokerJsonl.writeLine(srcReadLine);
    const srcReadResp = await brokerJsonl.readLine();
    assertEquals(JSON.parse(srcReadResp!).result, "allow");

    const srcWriteLine = JSON.stringify({
      v: 1,
      pid: 1,
      id: 3,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "write",
      value: path.join(env.projectRoot, "src", "secret.ts"),
    });
    await brokerJsonl.writeLine(srcWriteLine);
    const srcWriteResp = await brokerJsonl.readLine();
    assertEquals(JSON.parse(srcWriteResp!).result, "deny");
  } finally {
    brokerConn.close();
    controller.abort();
    await done;
    await cleanupEnv(env);
  }
});

Deno.test({
  name: "broker daemon prompts via control socket",
  ignore: !integrationEnabled(),
}, async () => {
  const { env, controller, done } = await makeEnv(true);

  const controlConn = await Deno.connect({ transport: "unix", path: env.controlPath });
  const brokerConn = await Deno.connect({ transport: "unix", path: env.brokerPath });
  const controlJsonl = new JsonlConnection(controlConn);
  const brokerJsonl = new JsonlConnection(brokerConn);

  try {
    await controlJsonl.writeLine(formatControlMessage({ type: "register", pid: 42 }));
    await new Promise((r) => setTimeout(r, 20));

    const runLine = JSON.stringify({
      v: 1,
      pid: 1,
      id: 10,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "run",
      value: "/bin/sh",
    });
    await brokerJsonl.writeLine(runLine);

    const promptLine = await controlJsonl.readLine();
    assertEquals(parseControlMessage(promptLine!).type, "prompt");
    const prompt = parseControlMessage(promptLine!);
    if (prompt.type !== "prompt") throw new Error("expected prompt");

    await controlJsonl.writeLine(
      formatControlMessage({
        type: "decision",
        requestId: prompt.requestId,
        result: "allow",
        grant: "once",
      }),
    );

    const runResp = await brokerJsonl.readLine();
    assertEquals(JSON.parse(runResp!).result, "allow");
  } finally {
    controlConn.close();
    brokerConn.close();
    controller.abort();
    await done;
    await cleanupEnv(env);
  }
});

Deno.test({
  name: "broker daemon returns one matching response per request line",
  ignore: !integrationEnabled(),
}, async () => {
  const { env, controller, done } = await makeEnv(false);

  const brokerConn = await Deno.connect({ transport: "unix", path: env.brokerPath });
  const brokerJsonl = new JsonlConnection(brokerConn);

  try {
    const first = JSON.stringify({
      v: 1,
      pid: 1,
      id: 100,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "read",
      value: path.join(env.workspacePath, "a", "f.txt"),
    });
    const second = JSON.stringify({
      v: 1,
      pid: 1,
      id: 101,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "write",
      value: path.join(env.projectRoot, "src", "secret.ts"),
    });
    await brokerConn.write(encoder.encode(`${first}\n${second}\n`));

    const firstResp = await brokerJsonl.readLine();
    const secondResp = await brokerJsonl.readLine();
    assertEquals(JSON.parse(firstResp!).id, 100);
    assertEquals(JSON.parse(firstResp!).result, "allow");
    assertEquals(JSON.parse(secondResp!).id, 101);
    assertEquals(JSON.parse(secondResp!).result, "deny");
  } finally {
    brokerConn.close();
    controller.abort();
    await done;
    await cleanupEnv(env);
  }
});

Deno.test({
  name: "broker daemon cached grant allows before control registration",
  ignore: !integrationEnabled(),
}, async () => {
  const { env, controller, done } = await makeEnv(true);

  const controlConn = await Deno.connect({ transport: "unix", path: env.controlPath });
  const brokerConn = await Deno.connect({ transport: "unix", path: env.brokerPath });
  const controlJsonl = new JsonlConnection(controlConn);
  const brokerJsonl = new JsonlConnection(brokerConn);

  try {
    await controlJsonl.writeLine(formatControlMessage({
      type: "grant",
      permission: "run",
      value: "/bin/sh",
      scope: "session",
    }));
    await new Promise((r) => setTimeout(r, 20));

    await brokerJsonl.writeLine(JSON.stringify({
      v: 1,
      pid: 1,
      id: 200,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "run",
      value: "/bin/sh",
    }));

    const response = await brokerJsonl.readLine();
    assertEquals(JSON.parse(response!).id, 200);
    assertEquals(JSON.parse(response!).result, "allow");
  } finally {
    controlConn.close();
    brokerConn.close();
    controller.abort();
    await done;
    await cleanupEnv(env);
  }
});

Deno.test({
  name: "broker daemon once grant allows exactly one matching request before registration",
  ignore: !integrationEnabled(),
}, async () => {
  const { env, controller, done } = await makeEnv(true);

  const controlConn = await Deno.connect({ transport: "unix", path: env.controlPath });
  const brokerConn = await Deno.connect({ transport: "unix", path: env.brokerPath });
  const controlJsonl = new JsonlConnection(controlConn);
  const brokerJsonl = new JsonlConnection(brokerConn);

  try {
    await controlJsonl.writeLine(formatControlMessage({
      type: "grant",
      permission: "run",
      value: "/bin/sh",
      scope: "once",
    }));
    await new Promise((r) => setTimeout(r, 20));

    for (const id of [300, 301]) {
      // deno-lint-ignore no-await-in-loop -- Requests must be observed sequentially for one-time grant consumption.
      await brokerJsonl.writeLine(JSON.stringify({
        v: 1,
        pid: 1,
        id,
        datetime: "2025-01-01T00:00:00.000Z",
        permission: "run",
        value: "/bin/sh",
      }));
    }

    const first = await brokerJsonl.readLine();
    const second = await brokerJsonl.readLine();
    assertEquals(JSON.parse(first!).id, 300);
    assertEquals(JSON.parse(first!).result, "allow");
    assertEquals(JSON.parse(second!).id, 301);
    assertEquals(JSON.parse(second!).result, "deny");
  } finally {
    controlConn.close();
    brokerConn.close();
    controller.abort();
    await done;
    await cleanupEnv(env);
  }
});

async function cleanupEnv(env: BrokerDaemonEnv): Promise<void> {
  try {
    await Deno.remove(path.dirname(env.brokerPath), { recursive: true });
  } catch {
    /* already removed */
  }
}

async function waitForSocket(sockPath: string, startupError: () => unknown): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const error = startupError();
    if (error) throw error;
    try {
      // deno-lint-ignore no-await-in-loop -- Socket readiness must be polled sequentially.
      await Deno.stat(sockPath);
      return;
    } catch {
      /* socket not created yet */
    }
    // deno-lint-ignore no-await-in-loop -- Socket readiness polling needs a delay between attempts.
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`socket not ready: ${sockPath}`);
}
