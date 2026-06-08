import { assertEquals } from "jsr:@std/assert@1";

import { startTelegramTypingIndicator } from "../../src/telegram/typing-indicator.ts";

class FakeTypingApi {
  calls: Array<{ chatId: number; action: "typing"; options?: { message_thread_id?: number } }> = [];
  fail = false;

  sendChatAction(
    chatId: number,
    action: "typing",
    options?: { message_thread_id?: number },
  ): Promise<unknown> {
    this.calls.push({ chatId, action, options });
    if (this.fail) throw new Error("Telegram unavailable");
    return Promise.resolve();
  }
}

class ManualScheduler {
  callbacks = new Map<number, () => void>();
  intervals: number[] = [];
  cleared: number[] = [];
  private _nextId = 1;

  setInterval(callback: () => void, intervalMs: number): number {
    const id = this._nextId++;
    this.callbacks.set(id, callback);
    this.intervals.push(intervalMs);
    return id;
  }

  clearInterval(id: number): void {
    this.cleared.push(id);
    this.callbacks.delete(id);
  }

  tick(id = 1): void {
    this.callbacks.get(id)?.();
  }
}

Deno.test("Telegram typing indicator sends immediately and refreshes until stopped", async () => {
  const api = new FakeTypingApi();
  const scheduler = new ManualScheduler();
  const stop = startTelegramTypingIndicator({
    api,
    chatId: 123,
    threadId: 456,
    signal: new AbortController().signal,
    intervalMs: 10,
    scheduler,
  });

  await Promise.resolve();
  scheduler.tick();
  await Promise.resolve();
  stop();
  scheduler.tick();
  await Promise.resolve();

  assertEquals(scheduler.intervals, [10]);
  assertEquals(scheduler.cleared, [1]);
  assertEquals(api.calls, [
    { chatId: 123, action: "typing", options: { message_thread_id: 456 } },
    { chatId: 123, action: "typing", options: { message_thread_id: 456 } },
  ]);
});

Deno.test("Telegram typing indicator stops when its signal aborts", async () => {
  const api = new FakeTypingApi();
  const scheduler = new ManualScheduler();
  const controller = new AbortController();

  startTelegramTypingIndicator({
    api,
    chatId: 123,
    signal: controller.signal,
    scheduler,
  });
  controller.abort();
  scheduler.tick();
  await Promise.resolve();

  assertEquals(scheduler.cleared, [1]);
  assertEquals(api.calls.length, 1);
});

Deno.test("Telegram typing indicator ignores Telegram API failures", async () => {
  const api = new FakeTypingApi();
  const scheduler = new ManualScheduler();
  api.fail = true;

  const stop = startTelegramTypingIndicator({
    api,
    chatId: 123,
    signal: new AbortController().signal,
    scheduler,
  });
  scheduler.tick();
  await Promise.resolve();
  stop();

  assertEquals(api.calls.length, 2);
});
