import * as path from "@std/path";

import { grantBrokerRunForCommands } from "../../permission-broker/mod.ts";

export const SEARCH_SKIP_DIRS = new Set([".git", "node_modules"]);

export function toPosixPath(value: string): string {
  return value.split(path.SEPARATOR).join("/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regexes for `@std/fs/walk` skip directories used by search fallbacks. */
export function searchSkipPatterns(): RegExp[] {
  return [...SEARCH_SKIP_DIRS].map((name) => new RegExp(`(^|[/\\\\])${escapeRegExp(name)}([/\\\\]|$)`));
}

export async function commandExists(name: string, signal?: AbortSignal): Promise<boolean> {
  await grantBrokerRunForCommands(["which"], signal);
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
