import { BOOTSTRAP_ENV_VARS, BOOTSTRAP_NET_HOSTS, TRUSTED_IMPORT_HOSTS } from "./bootstrap-fixtures.ts";
import { isUnderRoot, normalizeAbsolutePath, stripPathQuotes } from "./paths.ts";
import { type BrokerRequest, normalizeBrokerValue, type PolicyDecision } from "./protocol.ts";

/** Inputs used by the permission policy engine. */
export interface PolicyContext {
  workspaceRoot: string;
  projectRoot: string;
  denoDir: string;
  repoSrcDir: string;
  brokerSocketPaths: readonly string[];
  runPromptsEnabled: boolean;
}

/** Builds policy context from environment and resolved paths. */
export function createPolicyContext(spec: {
  workspaceRoot: string;
  projectRoot: string;
  denoDir: string;
  brokerSocketPaths?: readonly string[];
  runPromptsEnabled: boolean;
}): PolicyContext {
  const repoSrcDir = normalizeAbsolutePath(`${spec.projectRoot}/src`);
  return {
    workspaceRoot: spec.workspaceRoot,
    projectRoot: spec.projectRoot,
    denoDir: spec.denoDir,
    repoSrcDir,
    brokerSocketPaths: (spec.brokerSocketPaths ?? []).map(normalizeAbsolutePath),
    runPromptsEnabled: spec.runPromptsEnabled,
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

function decideReadWrite(kind: "read" | "write", pathValue: string | null, ctx: PolicyContext): PolicyDecision {
  if (pathValue === null) return "prompt";
  const target = normalizedPath(pathValue);
  if (!target) return "prompt";
  if (ctx.brokerSocketPaths.includes(target)) return "auto_allow";
  if (kind === "write" && isUnderRoot(target, ctx.repoSrcDir)) return "auto_deny";
  if (isUnderRoot(target, ctx.workspaceRoot)) return "auto_allow";
  if (isUnderRoot(target, ctx.denoDir)) return "auto_allow";
  // Silas must read its own tree at startup; broker policy protects repo source writes.
  if (kind === "read" && isUnderRoot(target, ctx.projectRoot)) return "auto_allow";
  if (target.startsWith("/etc") || target.includes("/.ssh")) return "auto_deny";
  return "prompt";
}

function decideNet(value: string | null, ctx: PolicyContext): PolicyDecision {
  if (value === null) return "prompt";
  const stripped = stripPathQuotes(value);
  if (stripped.startsWith("/")) {
    const socketPath = normalizeAbsolutePath(stripped);
    if (ctx.brokerSocketPaths.includes(socketPath)) return "auto_allow";
  }
  const host = stripped.replace(/^https?:\/\//, "");
  if (isBootstrapNetHost(host)) return "auto_allow";
  return "prompt";
}

function decideEnv(value: string | null): PolicyDecision {
  // Node compatibility shims used by npm packages enumerate process.env during import.
  // This happens before the Telegram control client can prompt.
  if (value === null) return "auto_allow";
  const name = stripPathQuotes(value);
  if ((BOOTSTRAP_ENV_VARS as readonly string[]).includes(name)) return "auto_allow";
  // After enumeration, Node's process.env proxy reads descriptors/values for inherited keys.
  // Unknown env keys are not a meaningful security boundary once enumeration is allowed.
  return "auto_allow";
}

function decideRun(ctx: PolicyContext): PolicyDecision {
  if (!ctx.runPromptsEnabled) return "auto_deny";
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
 * Mutable grants and prompt readiness are applied by the daemon before/after this classification.
 */
export function decidePolicy(request: BrokerRequest, ctx: PolicyContext): PolicyDecision {
  const value = normalizeBrokerValue(request.value);

  switch (request.permission) {
    case "read":
      return decideReadWrite("read", value, ctx);
    case "write":
      return decideReadWrite("write", value, ctx);
    case "net":
      return decideNet(value, ctx);
    case "env":
      return decideEnv(value);
    case "run":
      return decideRun(ctx);
    case "import":
      return decideImport(value);
    case "ffi":
    case "sys":
      return "auto_deny";
    default:
      return "prompt";
  }
}
