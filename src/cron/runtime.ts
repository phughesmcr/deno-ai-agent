import type { CronDispatcher } from "./dispatcher.ts";

let dispatcher: CronDispatcher | undefined;

/** Installs the dispatcher used by the static `Deno.cron` callback. */
export function setCronDispatcher(next: CronDispatcher): void {
  dispatcher = next;
}

Deno.cron("silas-cron-dispatcher", "* * * * *", async () => {
  await dispatcher?.tick();
});
