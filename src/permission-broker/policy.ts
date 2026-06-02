import { BOOTSTRAP_ENV_VARS, BOOTSTRAP_NET_HOSTS, TRUSTED_IMPORT_HOSTS } from "./bootstrap-fixtures.ts";
import { isUnderRoot, normalizeAbsolutePath, stripPathQuotes } from "./paths.ts";
import { type BrokerRequest, normalizeBrokerValue, type PolicyDecision } from "./protocol.ts";
import type { SessionCache } from "./session-cache.ts";

/** Inputs used by the permission policy engine. */
export interface PolicyContext {
  workspaceRoot: string;
  projectRoot: string;
  denoDir: string;
  repoSrcDir: string;
  runPromptsEnabled: boolean;
  controlRegistered: boolean;
  cache: SessionCache;
}

/** Builds policy context from environment and resolved paths. */
export function createPolicyContext(spec: {
  workspaceRoot: string;
  projectRoot: string;
  denoDir: string;
  runPromptsEnabled: boolean;
  controlRegistered: boolean;
  cache: SessionCache;
}): PolicyContext {
  const repoSrcDir = normalizeAbsolutePath(`${spec.projectRoot}/src`);
  return {
    workspaceRoot: spec.workspaceRoot,
    projectRoot: spec.projectRoot,
    denoDir: spec.denoDir,
    repoSrcDir,
    runPromptsEnabled: spec.runPromptsEnabled,
    controlRegistered: spec.controlRegistered,
    cache: spec.cache,
  };
}

function normalizedPath(value: string | null): string | null {
  if (value === null) return null;
  return normalizeAbsolutePath(stripPathQuotes(value));
}

function isBootstrapNetHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return BOOTSTRAP_NET_HOSTS.some((allowed) =>
    normalized === allowed.toLowerCase() || normalized.startsWith(`${allowed.split(":")[0]}:`)
  );
}

function isTrustedImportHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? host;
  return TRUSTED_IMPORT_HOSTS.some((trusted) =>
    normalized === trusted || normalized.endsWith(`.${trusted}`) || normalized.startsWith(`${trusted}:`)
  );
}

function decideReadWrite(_kind: "read" | "write", pathValue: string | null, ctx: PolicyContext): PolicyDecision {
  if (pathValue === null) return "prompt";
  const target = normalizedPath(pathValue);
  if (!target) return "prompt";
  if (isUnderRoot(target, ctx.workspaceRoot)) return "auto_allow";
  if (isUnderRoot(target, ctx.denoDir)) return "auto_allow";
  if (isUnderRoot(target, ctx.repoSrcDir)) return "auto_deny";
  if (target.startsWith("/etc") || target.includes("/.ssh")) return "auto_deny";
  if (target.startsWith(Deno.env.get("HOME") ?? "/home")) return "auto_deny";
  return "prompt";
}

function decideNet(value: string | null): PolicyDecision {
  if (value === null) return "prompt";
  const host = stripPathQuotes(value).replace(/^https?:\/\//, "");
  if (isBootstrapNetHost(host)) return "auto_allow";
  return "prompt";
}

function decideEnv(value: string | null): PolicyDecision {
  if (value === null) return "prompt";
  const name = stripPathQuotes(value);
  if ((BOOTSTRAP_ENV_VARS as readonly string[]).includes(name)) return "auto_allow";
  return "prompt";
}

function decideRun(ctx: PolicyContext, value: string | null): PolicyDecision {
  if (!ctx.runPromptsEnabled) return "auto_deny";
  if (ctx.cache.has("run", value)) return "auto_allow";
  return "prompt";
}

function decideImport(value: string | null): PolicyDecision {
  if (value === null) return "auto_allow";
  const host = stripPathQuotes(value);
  if (isTrustedImportHost(host)) return "auto_allow";
  return "prompt";
}

/**
 * Classifies a broker request.
 * When `controlRegistered` is false, `prompt` is coerced to `auto_deny` by the daemon.
 */
export function decidePolicy(request: BrokerRequest, ctx: PolicyContext): PolicyDecision {
  const value = normalizeBrokerValue(request.value);
  if (ctx.cache.has(request.permission, value)) return "auto_allow";

  switch (request.permission) {
    case "read":
      return decideReadWrite("read", value, ctx);
    case "write":
      return decideReadWrite("write", value, ctx);
    case "net":
      return decideNet(value);
    case "env":
      return decideEnv(value);
    case "run":
      return decideRun(ctx, value);
    case "import":
      return decideImport(value);
    case "ffi":
    case "sys":
      return "auto_deny";
    default:
      return "prompt";
  }
}

/** Applies pre-register rule: never prompt before control client registers. */
export function effectiveDecision(decision: PolicyDecision, ctx: PolicyContext): PolicyDecision {
  if (decision === "prompt" && !ctx.controlRegistered) return "auto_deny";
  return decision;
}
