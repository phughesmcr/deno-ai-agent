import * as path from "@std/path";

function normalizeRoot(root: string): string {
  const resolved = path.resolve(root);
  return resolved.endsWith(path.SEPARATOR) ? resolved.slice(0, -1) : resolved;
}

function isPathInsideRoot(resolved: string, root: string): boolean {
  if (resolved === root) return true;
  return resolved.startsWith(root + path.SEPARATOR);
}

function workspaceEscapeMessage(userPath: string, root: string): string {
  const displayRoot = root.split(path.SEPARATOR).join("/");
  return `Path escapes workspace: "${userPath}" is outside the tool root (${displayRoot}). ` +
    "Use relative paths under the workspace, or an absolute / ~/... path for approved host access.";
}

/** Expands a leading `~` using `HOME` when set. */
export function expandTilde(userPath: string): string {
  if (userPath === "~") {
    return Deno.env.get("HOME") ?? userPath;
  }
  if (userPath.startsWith("~/") || userPath.startsWith("~\\")) {
    const home = Deno.env.get("HOME");
    if (!home) return userPath;
    return path.join(home, userPath.slice(2));
  }
  return userPath;
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await Deno.realPath(value);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return normalizeRoot(value);
    throw error;
  }
}

async function nearestExistingPath(value: string): Promise<string> {
  let current = value;
  while (true) {
    try {
      // deno-lint-ignore no-await-in-loop -- each candidate depends on the previous missing parent.
      await Deno.lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }

    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/** Canonical workspace path resolver that rejects traversal and symlink escapes. */
export class WorkspaceSandbox {
  readonly #root: string;

  private constructor(root: string) {
    this.#root = root;
  }

  /** Creates a sandbox with a canonical root. */
  static async create(root: string): Promise<WorkspaceSandbox> {
    return new WorkspaceSandbox(await canonicalPath(root));
  }

  /** Canonical workspace root. */
  get root(): string {
    return this.#root;
  }

  /** True when `absolutePath` is the workspace root or under it. */
  containsPath(absolutePath: string): boolean {
    return isPathInsideRoot(absolutePath, this.#root);
  }

  /**
   * Resolves a host path (absolute or `~`-prefixed) outside the workspace sandbox.
   * Canonicalizes symlinks on existing path segments; missing leaf paths are allowed.
   */
  async resolveHostPath(userPath: string): Promise<string> {
    const resolved = path.resolve(expandTilde(userPath));
    try {
      return await Deno.realPath(resolved);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return resolved;
      throw error;
    }
  }

  /**
   * Resolves a user path under the workspace.
   *
   * Missing targets are allowed, but their nearest existing parent must resolve
   * inside the workspace. This prevents writes through symlinks.
   */
  async resolvePath(userPath: string): Promise<string> {
    const base = path.isAbsolute(userPath) ? userPath : path.join(this.#root, userPath || ".");
    const resolved = path.resolve(base);

    if (!isPathInsideRoot(resolved, this.#root)) {
      throw new Error(workspaceEscapeMessage(userPath, this.#root));
    }

    const existingPath = await nearestExistingPath(resolved);
    const canonicalExistingPath = await Deno.realPath(existingPath);
    if (!isPathInsideRoot(canonicalExistingPath, this.#root)) {
      throw new Error(workspaceEscapeMessage(userPath, this.#root));
    }

    try {
      const canonicalTarget = await Deno.realPath(resolved);
      if (!isPathInsideRoot(canonicalTarget, this.#root)) {
        throw new Error(workspaceEscapeMessage(userPath, this.#root));
      }
      return canonicalTarget;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return resolved;
      throw error;
    }
  }

  /** Resolves and verifies an existing directory. */
  async resolveDirectoryPath(userPath: string): Promise<string> {
    const resolved = await this.resolvePath(userPath || ".");
    const stat = await Deno.stat(resolved);
    if (!stat.isDirectory) throw new Error(`Not a directory: ${resolved}`);
    return resolved;
  }

  /** Converts an absolute path to a workspace-relative display path when possible. */
  displayPath(absolutePath: string): string {
    const rel = path.relative(this.#root, absolutePath);
    if (rel === "" || rel === ".") return ".";
    if (rel.startsWith("..") || path.isAbsolute(rel)) return absolutePath;
    return rel.split(path.SEPARATOR).join("/");
  }
}
