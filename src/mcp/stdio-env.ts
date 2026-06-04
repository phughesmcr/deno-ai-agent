import * as path from "@std/path";

/** Env vars that must not be passed to MCP stdio children (they inherit the broker and hang). */
const BROKER_ENV_KEYS = [
  "DENO_PERMISSION_BROKER_PATH",
  "SILAS_PERMISSION_CONTROL_PATH",
  "SILAS_BROKER_LISTEN_PATH",
  "SILAS_PERMISSION_RUN_PROMPTS",
  "SILAS_PROJECT_ROOT",
] as const;

const INHERITED_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"] as const;

function minimalInheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV_KEYS) {
    try {
      const v = Deno.env.get(name);
      if (v !== undefined) env[name] = v;
    } catch { /* env access denied */ }
  }
  return env;
}

/**
 * Builds subprocess env for MCP stdio servers: config overrides + safe inherited vars,
 * never the permission broker (child servers would block on broker prompts).
 */
export function stdioChildEnv(configEnv: Record<string, string>): Record<string, string> {
  const env = { ...minimalInheritedEnv(), ...configEnv };
  for (const key of BROKER_ENV_KEYS) delete env[key];
  return env;
}

/** Absolute paths from stdio server args/cwd that need broker read grants in the parent. */
export function stdioBrokerReadPaths(config: {
  args: string[];
  cwd?: string;
}): string[] {
  const paths: string[] = [];
  if (config.cwd) paths.push(path.resolve(config.cwd));
  for (const arg of config.args) {
    if (path.isAbsolute(arg)) paths.push(arg);
  }
  return paths;
}
