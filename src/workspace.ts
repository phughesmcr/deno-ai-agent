import { debounce } from "@std/async/debounce";
import { Result } from "./utils.ts";

/** Workspace directory and loaded system prompt. */
export interface Workspace {
  /** Absolute path to the workspace directory. */
  readonly path: string;
  /** Contents of `SYSTEM.md` in the workspace. */
  readonly systemPrompt: string;
  /** Closes the filesystem watcher when the workspace is disposed. */
  [Symbol.dispose]: () => void;
}

function getEnv(): { workspacePath: string } {
  const workspacePath = Deno.env.get("WORKSPACE_PATH");
  if (!workspacePath) throw new Error("WORKSPACE_PATH is not set");
  return { workspacePath };
}

/** Creates a workspace from `WORKSPACE_PATH` and watches for file changes. */
export async function createWorkspace(rootDir: URL, onWatchEvent: (event: Deno.FsEvent) => void): Promise<Workspace> {
  const { workspacePath } = getEnv();

  const dir = new URL(workspacePath, rootDir);
  const path = dir.pathname;
  const result = await Result.try(() => Deno.mkdirSync(path, { recursive: true }));
  if (!result.success) throw result.error;

  const systemPrompt = await Result.try(() => Deno.readTextFile(`${path}/SYSTEM.md`));
  if (!systemPrompt.success) throw systemPrompt.error;

  const watcher = Deno.watchFs([path], { recursive: true });
  void (async () => {
    const debouncedOnWatchEvent = debounce(onWatchEvent, 200);
    for await (const event of watcher) {
      void debouncedOnWatchEvent(event);
    }
  })();

  return { path, systemPrompt: systemPrompt.value, [Symbol.dispose]: () => watcher.close() };
}
