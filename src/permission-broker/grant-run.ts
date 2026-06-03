import * as path from "@std/path";

import { sendControlGrant } from "./control-channel.ts";
import { shouldRunPermissionControlClient } from "./control-client.ts";

/**
 * Pre-grants broker `run` values for approved commands.
 * @internal
 */
export async function grantBrokerRunValues(values: readonly string[], signal?: AbortSignal): Promise<void> {
  for (const value of new Set(values)) {
    if (signal?.aborted) return;
    // deno-lint-ignore no-await-in-loop -- Grant frames must stay in order on the control socket.
    await sendControlGrant("run", value, "session", signal);
  }
}

function executableNames(name: string): string[] {
  if (Deno.build.os === "windows") {
    return name.toLowerCase().endsWith(".exe") ? [name] : [`${name}.exe`, name];
  }
  return [name];
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(filePath);
    return stat.isFile || stat.isSymlink;
  } catch {
    return false;
  }
}

/** Resolves a command name to an absolute executable path when it exists on PATH. */
export async function resolveExecutableOnPath(name: string): Promise<string | undefined> {
  for (const candidate of executableNames(name)) {
    if (path.isAbsolute(candidate)) {
      if (await isExecutableFile(candidate)) return candidate;
      continue;
    }
    let pathEnv: string | undefined;
    try {
      pathEnv = Deno.env.get("PATH");
    } catch {
      return undefined;
    }
    if (!pathEnv) continue;
    for (const dir of pathEnv.split(path.DELIMITER)) {
      if (!dir) continue;
      const full = path.join(dir, candidate);
      if (await isExecutableFile(full)) return full;
    }
  }
  return undefined;
}

/**
 * Pre-grants broker `run` for command names and their PATH-resolved executables.
 * No-op when the permission control client is not active.
 */
export async function grantBrokerRunForCommands(
  names: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (!shouldRunPermissionControlClient()) return;
  const values = new Set<string>();
  for (const name of names) {
    if (signal?.aborted) return;
    if (!name) continue;
    values.add(name);
    const resolved = await resolveExecutableOnPath(name);
    if (resolved) values.add(resolved);
  }
  await grantBrokerRunValues([...values], signal);
}
