import * as path from "@std/path";

export const SEARCH_SKIP_DIRS = new Set([".git", "node_modules"]);

export function toPosixPath(value: string): string {
  return value.split(path.SEPARATOR).join("/");
}

export async function commandExists(name: string): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("which", { args: [name], stdout: "null", stderr: "null" }).output();
    return success;
  } catch {
    return false;
  }
}

export async function readStreamToString(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

export function appendSearchNotices(output: string, notices: string[]): string {
  return notices.length > 0 ? `${output}\n\n[${notices.join(". ")}]` : output;
}
