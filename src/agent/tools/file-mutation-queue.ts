import * as path from "@std/path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
  return error instanceof Deno.errors.NotFound;
}

async function getMutationQueueKey(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  try {
    return await Deno.realPath(resolvedPath);
  } catch (error) {
    if (isMissingPathError(error)) return resolvedPath;
    throw error;
  }
}

/** Serialize file mutations targeting the same path; different paths run in parallel. */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await getMutationQueueKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

    const next = Promise.withResolvers<void>();
    const nextQueue = next.promise;
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);

    return { key, currentQueue, chainedQueue, releaseNext: next.resolve };
  });
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  );

  const { key, currentQueue, chainedQueue, releaseNext } = await registration;
  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
