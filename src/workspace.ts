import { debounce } from "@std/async/debounce";
import { Result } from "./utils.ts";

/** Workspace directory, system prompt, and session storage path. */
export interface Workspace {
  /** Absolute path to the workspace directory. */
  readonly path: string;
  /** Directory containing `{id}.json` session files. */
  readonly sessionsDir: string;
  /** Contents of `SYSTEM.md` in the workspace. */
  readonly systemPrompt: string;
  /** Re-reads `SYSTEM.md` from disk. */
  reloadSystemPrompt(): Promise<string>;
  /** Subscribes to filesystem events. */
  subscribeToFsEvents(onWatchEvent: (event: Deno.FsEvent) => void | Promise<void>): () => void;
  /** Closes the filesystem watcher when the workspace is disposed. */
  [Symbol.dispose]: () => void;
}

function getEnv(): { workspacePath: string } {
  const workspacePath = Deno.env.get("WORKSPACE_PATH");
  if (!workspacePath) throw new Error("WORKSPACE_PATH is not set");
  return { workspacePath };
}

/** Creates a workspace from `WORKSPACE_PATH` and watches for file changes. */
export async function createWorkspace(rootDir: URL): Promise<Workspace> {
  const { workspacePath } = getEnv();

  const dir = new URL(workspacePath, rootDir);
  const path = dir.pathname;
  const result = await Result.try(() => Deno.mkdirSync(path, { recursive: true }));
  if (!result.success) throw result.error;

  const systemPromptPath = `${path}/SYSTEM.md`;
  let systemPrompt = await readSystemPrompt(systemPromptPath);

  const sessionsDir = `${path}/sessions`;
  await Deno.mkdir(sessionsDir, { recursive: true });

  const subscribers = new Set<(event: Deno.FsEvent) => void>();
  const subscribeToFsEvents = (onWatchEvent: (event: Deno.FsEvent) => void | Promise<void>): () => void => {
    const debouncedOnWatchEvent = debounce(onWatchEvent, 200);
    subscribers.add(debouncedOnWatchEvent);
    return () => {
      subscribers.delete(debouncedOnWatchEvent);
    };
  };

  const watcher = Deno.watchFs([path], { recursive: true });
  void (async () => {
    for await (const event of watcher) {
      await Promise.all([...subscribers].map((subscriber) => Promise.try(subscriber, event)));
    }
  })();

  return {
    path,
    sessionsDir,
    get systemPrompt() {
      return systemPrompt;
    },
    async reloadSystemPrompt(): Promise<string> {
      systemPrompt = await readSystemPrompt(systemPromptPath);
      return systemPrompt;
    },
    subscribeToFsEvents,
    [Symbol.dispose]: () => watcher.close(),
  };
}

async function readSystemPrompt(path: string): Promise<string> {
  const result = await Result.try(() => Deno.readTextFile(path));
  if (!result.success) throw result.error;
  return result.value;
}
