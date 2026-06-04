import { debounce } from "@std/async/debounce";
import { logDebug } from "../shared/log.ts";
import { preprocessSystemPrompt } from "./tools/prompt.ts";

/**
 * Filesystem watcher subscriber callback.
 * @internal
 */
export type FsSubscriber = (event: Deno.FsEvent) => void | Promise<void>;

/** Workspace directory, system prompt, and session storage path. */
export interface Workspace {
  /** Absolute path to the workspace directory. */
  readonly path: string;
  /** Directory containing `{id}.json` session files. */
  readonly sessionsDir: string;
  /** Directory containing `{id}.json` todo list files. */
  readonly todosDir: string;
  /** Contents of `SYSTEM.md` in the workspace. */
  readonly systemPrompt: string;
  /** Re-reads `SYSTEM.md` from disk. */
  reloadSystemPrompt(): Promise<string>;
  /** Subscribes to filesystem events. */
  subscribeToFsEvents(onWatchEvent: FsSubscriber): () => void;
  /** Closes the filesystem watcher when the workspace is disposed. */
  [Symbol.dispose]: () => void;
}

function getEnv(): { workspacePath: string } {
  const workspacePath = Deno.env.get("WORKSPACE_PATH");
  if (!workspacePath) throw new Error("WORKSPACE_PATH is not set");
  return { workspacePath };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Notifies filesystem watcher subscribers without letting one failure stop the watcher.
 * @internal
 */
export async function notifyWorkspaceSubscribers(
  subscribers: Iterable<FsSubscriber>,
  event: Deno.FsEvent,
): Promise<void> {
  const settled = await Promise.allSettled([...subscribers].map((subscriber) => Promise.try(subscriber, event)));
  for (const result of settled) {
    if (result.status === "rejected") {
      logDebug("workspace.subscriber.error", { message: errorMessage(result.reason) });
    }
  }
}

/** Creates a workspace from `WORKSPACE_PATH` and watches for file changes. */
export async function createWorkspace(rootDir: URL): Promise<Workspace> {
  const { workspacePath } = getEnv();

  const dir = new URL(workspacePath, rootDir);
  const path = dir.pathname;
  await Deno.mkdir(path, { recursive: true });

  const systemPromptPath = `${path}/SYSTEM.md`;
  let systemPrompt = preprocessSystemPrompt(await readSystemPrompt(systemPromptPath), path);

  const sessionsDir = `${path}/sessions`;
  await Deno.mkdir(sessionsDir, { recursive: true });

  const todosDir = `${path}/todos`;
  await Deno.mkdir(todosDir, { recursive: true });

  const subscribers = new Set<FsSubscriber>();
  const subscribeToFsEvents = (onWatchEvent: FsSubscriber): () => void => {
    const debouncedOnWatchEvent = debounce(onWatchEvent, 200);
    subscribers.add(debouncedOnWatchEvent);
    return () => {
      subscribers.delete(debouncedOnWatchEvent);
    };
  };

  const watcher = Deno.watchFs([path], { recursive: true });
  void (async () => {
    try {
      for await (const event of watcher) {
        await notifyWorkspaceSubscribers(subscribers, event);
      }
    } catch (error) {
      logDebug("workspace.watch.error", { message: errorMessage(error) });
    }
  })();

  return {
    path,
    sessionsDir,
    todosDir,
    get systemPrompt() {
      return systemPrompt;
    },
    async reloadSystemPrompt(): Promise<string> {
      systemPrompt = preprocessSystemPrompt(await readSystemPrompt(systemPromptPath), path);
      return systemPrompt;
    },
    subscribeToFsEvents,
    [Symbol.dispose]: () => watcher.close(),
  };
}

async function readSystemPrompt(path: string): Promise<string> {
  return await Deno.readTextFile(path);
}

/** Reads `BOOTSTRAP.md` when present; returns null if missing or whitespace-only. */
export async function readBootstrapIfPresent(workspacePath: string): Promise<string | null> {
  try {
    const text = await Deno.readTextFile(`${workspacePath}/BOOTSTRAP.md`);
    const trimmed = text.trim();
    return trimmed.length > 0 ? text : null;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}
