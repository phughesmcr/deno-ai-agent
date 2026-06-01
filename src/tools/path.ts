/** Join path segments with forward slashes (workspace-relative display). */
export function toPosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/** Ensure a path has no trailing separator (except root). */
export function normalizeRoot(root: string): string {
  if (root === "/") return root;
  return root.replace(/\/+$/, "");
}
