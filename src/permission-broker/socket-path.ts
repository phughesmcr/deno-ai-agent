/** Removes a Unix socket path when present. */
export async function removeSocketPath(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}
