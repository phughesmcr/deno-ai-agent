import * as path from "@std/path";

/** Returns a normalized absolute path without resolving symlinks. */
export function normalizeAbsolutePath(value: string): string {
  const resolved = path.resolve(value);
  return resolved.endsWith(path.SEPARATOR) ? resolved.slice(0, -1) : resolved;
}

/** Returns true when `target` is the same path or under `root`. */
export function isUnderRoot(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root + path.SEPARATOR);
}

/** Strips surrounding quotes from broker path values. */
export function stripPathQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
