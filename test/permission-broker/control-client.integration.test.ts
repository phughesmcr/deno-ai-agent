import * as path from "@std/path";
import { assertEquals } from "jsr:@std/assert@1";

import { runPermissionControlClient } from "../../src/permission-broker/control-client.ts";
import { formatControlMessage, parseControlMessage } from "../../src/permission-broker/control-protocol.ts";
import { JsonlConnection } from "../../src/permission-broker/jsonl.ts";
import type {
  PermissionCallbackDispatch,
  PermissionPromptPort,
  PermissionPromptRequest,
  PermissionPromptResult,
  PermissionPromptTurnTarget,
} from "../../src/permission-broker/permission-prompt-port.ts";

class BlockingPermissionPromptPort implements PermissionPromptPort {
  readonly prompts: PermissionPromptRequest[] = [];
  private _pending: PromiseWithResolvers<PermissionPromptResult> | undefined;
  aborts = 0;

  isPending(): boolean {
    return this._pending !== undefined;
  }

  setTurnContext(_target: PermissionPromptTurnTarget): void {}

  clearTurnContext(): void {}

  prompt(request: PermissionPromptRequest): Promise<PermissionPromptResult> {
    this.prompts.push(request);
    this._pending = Promise.withResolvers<PermissionPromptResult>();
    return this._pending.promise;
  }

  handleCallback(): Promise<PermissionCallbackDispatch> {
    return Promise.resolve({ handled: false });
  }

  abortPending(): void {
    this.aborts += 1;
    this._pending?.resolve({ result: "deny" });
    this._pending = undefined;
  }
}

function integrationEnabled(): boolean {
  try {
    return Deno.env.get("DENO_TEST_PERMISSION_BROKER") === "1";
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, deadline = performance.now() + 1_000): Promise<void> {
  if (predicate()) return;
  if (performance.now() > deadline) throw new Error("Timed out waiting for condition");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await waitUntil(predicate, deadline);
}

Deno.test({
  name: "control client aborts pending prompt when heartbeat detects disconnect",
  ignore: !integrationEnabled(),
}, async () => {
  const root = await Deno.makeTempDir({ dir: Deno.cwd(), prefix: ".silas-control-client-test-" });
  const controlPath = path.join(root, "control.sock");
  const listener = Deno.listen({ transport: "unix", path: controlPath });
  const controller = new AbortController();
  const port = new BlockingPermissionPromptPort();
  const clientDone = runPermissionControlClient({
    controlPath,
    promptPort: port,
    reconnectDelayMs: 10,
    heartbeatIntervalMs: 20,
  }, controller.signal);
  clientDone.catch(() => {});
  let conn: Deno.Conn | undefined;

  try {
    conn = await listener.accept();
    const control = new JsonlConnection(conn);
    const register = parseControlMessage((await control.readLine())!);
    assertEquals(register.type, "register");

    await control.writeLine(formatControlMessage({
      type: "prompt",
      requestId: "prompt-1",
      brokerId: 1,
      permission: "run",
      value: "/bin/sh",
    }));
    await waitUntil(() => port.prompts.length === 1);

    conn.close();
    await waitUntil(() => port.aborts === 1);
  } finally {
    controller.abort();
    try {
      conn?.close();
    } catch {
      /* already closed */
    }
    try {
      listener.close();
    } catch {
      /* already closed */
    }
    await clientDone.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});
