import * as path from "@std/path";
import { JsonlConnection } from "../../src/permission-broker/jsonl.ts";

const encoder = new TextEncoder();

async function main(): Promise<void> {
  const root = await Deno.makeTempDir();
  const workspace = path.join(root, "ws");
  const project = path.join(root, "project");
  await Deno.mkdir(path.join(workspace, "a"), { recursive: true });
  await Deno.mkdir(path.join(project, "src"), { recursive: true });
  const brokerSock = path.join(root, "broker.sock");
  const controlSock = path.join(root, "control.sock");

  const daemon = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "src/permission-broker/daemon-entry.ts",
    ],
    env: {
      WORKSPACE_PATH: workspace,
      SILAS_PROJECT_ROOT: project,
      SILAS_BROKER_LISTEN_PATH: brokerSock,
      SILAS_PERMISSION_CONTROL_PATH: controlSock,
      SILAS_PERMISSION_RUN_PROMPTS: "0",
      HOME: root,
    },
    cwd: path.dirname(path.fromFileUrl(new URL("../..", import.meta.url))),
  }).spawn();

  await new Promise((r) => setTimeout(r, 500));
  const conn = await Deno.connect({ transport: "unix", path: brokerSock });
  const jsonl = new JsonlConnection(conn);
  for (
    const [id, permission, value] of [
      [1, "read", path.join(workspace, "a", "f.txt")],
      [2, "read", path.join(project, "src", "secret.ts")],
    ] as const
  ) {
    // deno-lint-ignore no-await-in-loop -- Manual client sends and waits one broker request at a time.
    await jsonl.writeLine(JSON.stringify({ v: 1, pid: 1, id, datetime: "t", permission, value }));
    // deno-lint-ignore no-await-in-loop -- Manual client prints the matching response before the next request.
    const resp = await jsonl.readLine();
    // deno-lint-ignore no-await-in-loop -- Manual client output follows each matching broker response.
    await Deno.stdout.write(encoder.encode(`${id} ${resp ?? ""}\n`));
  }
  conn.close();
  daemon.kill();
}

if (import.meta.main) {
  void main();
}
