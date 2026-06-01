import { normalizeRoot } from "./path.ts";

/** Sandbox root for all tool paths and bash cwd. */
export interface ToolContext {
  /** Absolute workspace directory path. */
  readonly root: string;
}

function hasParentSegment(path: string): boolean {
  const parts = path.split(/[/\\]/);
  return parts.some((part) => part === "..");
}

function isUnderRoot(resolved: string, root: string): boolean {
  return resolved === root || resolved.startsWith(`${root}/`);
}

async function resolveWorkspaceRoot(ctx: ToolContext): Promise<string> {
  try {
    return normalizeRoot(await Deno.realPath(ctx.root));
  } catch {
    return normalizeRoot(ctx.root);
  }
}

/** Resolve a user path against the workspace root and verify it stays inside. */
export async function resolvePath(ctx: ToolContext, userPath: string): Promise<string> {
  const root = await resolveWorkspaceRoot(ctx);
  if (hasParentSegment(userPath)) {
    throw new Error("Path escapes workspace");
  }

  const base = userPath.startsWith("/") ? userPath : `${root}/${userPath.replace(/^\.\//, "")}`;
  const normalizedBase = normalizeRoot(base);

  try {
    const resolved = normalizeRoot(await Deno.realPath(base));
    if (!isUnderRoot(resolved, root)) {
      throw new Error("Path escapes workspace");
    }
    return resolved;
  } catch (error) {
    if (error instanceof Error && error.message === "Path escapes workspace") throw error;
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const slashIdx = normalizedBase.lastIndexOf("/");
  const parent = slashIdx > 0 ? normalizedBase.slice(0, slashIdx) : "";
  if (parent.length >= root.length) {
    try {
      const resolvedParent = normalizeRoot(await Deno.realPath(parent));
      if (!isUnderRoot(resolvedParent, root)) {
        throw new Error("Path escapes workspace");
      }
      const suffix = normalizedBase.slice(parent.length);
      const resolved = normalizeRoot(`${resolvedParent}${suffix}`);
      if (!isUnderRoot(resolved, root)) {
        throw new Error("Path escapes workspace");
      }
      return resolved;
    } catch (error) {
      if (error instanceof Error && error.message === "Path escapes workspace") throw error;
    }
  }

  if (!isUnderRoot(normalizedBase, root)) {
    throw new Error("Path escapes workspace");
  }
  return normalizedBase;
}

/** Resolve and verify an existing path is under the workspace root. */
export async function resolveExistingPath(ctx: ToolContext, userPath: string): Promise<string> {
  const resolved = await resolvePath(ctx, userPath);
  try {
    await Deno.stat(resolved);
  } catch {
    throw new Error(`Path not found: ${userPath}`);
  }
  return resolved;
}

/** Resolve a directory path; throw if missing or not a directory. */
export async function resolveDirectory(ctx: ToolContext, userPath: string): Promise<string> {
  const resolved = await resolveExistingPath(ctx, userPath);
  const stat = await Deno.stat(resolved);
  if (!stat.isDirectory) {
    throw new Error(`Not a directory: ${userPath}`);
  }
  return resolved;
}

/** Relative path from workspace root for tool output. */
export function relativeToRoot(ctx: ToolContext, absolutePath: string): string {
  const root = normalizeRoot(ctx.root);
  if (absolutePath === root) return ".";
  if (absolutePath.startsWith(`${root}/`)) {
    return absolutePath.slice(root.length + 1);
  }
  return absolutePath;
}
