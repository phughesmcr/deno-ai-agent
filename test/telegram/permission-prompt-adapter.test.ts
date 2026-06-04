// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.
import { assertEquals } from "jsr:@std/assert@1";

import type { PermissionPromptRequest } from "../../src/permission-broker/mod.ts";
import { createTelegramPermissionPromptPort } from "../../src/telegram/grammy-permission-prompt-adapter.ts";
import { encodePermissionCallback, toShortRequestId } from "../../src/telegram/permission-callback.ts";

interface FakeTurnContext {
  config: { adminId: number; isAdmin: boolean };
  message: { message_thread_id: number; chat: { id: number } };
  replies: string[];
  reply(text: string): Promise<unknown>;
}

function request(overrides: Partial<PermissionPromptRequest> = {}): PermissionPromptRequest {
  return {
    requestId: "12345678-1234-1234-1234-123456789abc",
    brokerId: 1,
    permission: "run",
    value: "deno task test",
    ...overrides,
  };
}

function fakeTurnContext(adminId = 42): FakeTurnContext {
  return {
    config: { adminId, isAdmin: true },
    message: { message_thread_id: 9, chat: { id: 123 } },
    replies: [] as string[],
    reply(text: string): Promise<unknown> {
      this.replies.push(text);
      return Promise.resolve({ message_id: this.replies.length });
    },
  };
}

function callbackData(requestId: string, action: "once" | "session" | "deny"): string {
  return encodePermissionCallback(toShortRequestId(requestId), action);
}

Deno.test("Telegram permission prompt allows matching admin callbacks", async () => {
  const port = createTelegramPermissionPromptPort(1_000);
  const ctx = fakeTurnContext();
  const prompt = request();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = port.prompt(prompt);
  await Promise.resolve();
  assertEquals(port.isPending(), true);

  const dispatch = await port.handleCallback(callbackData(prompt.requestId, "session"), 42, 42);

  assertEquals(dispatch.handled, true);
  assertEquals(await pending, { result: "allow", grant: "session" });
  assertEquals(port.isPending(), false);
});

Deno.test("Telegram permission prompt leaves pending prompt untouched for wrong-user callbacks", async () => {
  const port = createTelegramPermissionPromptPort(1_000);
  const ctx = fakeTurnContext();
  const prompt = request();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = port.prompt(prompt);
  await Promise.resolve();

  const dispatch = await port.handleCallback(callbackData(prompt.requestId, "once"), 7, 42);

  assertEquals(dispatch.handled, true);
  assertEquals(dispatch.answer?.text, "Not authorized.");
  assertEquals(port.isPending(), true);

  await port.handleCallback(callbackData(prompt.requestId, "deny"), 42, 42);
  assertEquals(await pending, { result: "deny" });
});

Deno.test("Telegram permission prompt ignores stale callbacks while pending", async () => {
  const port = createTelegramPermissionPromptPort(1_000);
  const ctx = fakeTurnContext();
  const prompt = request();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = port.prompt(prompt);
  await Promise.resolve();

  const stale = await port.handleCallback(callbackData("87654321-1234-1234-1234-123456789abc", "once"), 42, 42);

  assertEquals(stale.handled, true);
  assertEquals(stale.answer?.text, "This permission prompt has expired.");
  assertEquals(port.isPending(), true);

  await port.handleCallback(callbackData(prompt.requestId, "once"), 42, 42);
  assertEquals(await pending, { result: "allow", grant: "once" });
});

Deno.test("Telegram permission prompt handles two sequential prompts", async () => {
  const port = createTelegramPermissionPromptPort(1_000);
  const ctx = fakeTurnContext();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const first = request({ requestId: "aaaaaaaa-1111-1111-1111-111111111111" });
  const second = request({ requestId: "bbbbbbbb-2222-2222-2222-222222222222", value: "/bin/ls" });

  const pendingFirst = port.prompt(first);
  await Promise.resolve();
  await port.handleCallback(callbackData(first.requestId, "once"), 42, 42);
  assertEquals(await pendingFirst, { result: "allow", grant: "once" });
  assertEquals(port.isPending(), false);

  const pendingSecond = port.prompt(second);
  await Promise.resolve();
  assertEquals(ctx.replies.length, 2);

  await port.handleCallback(callbackData(second.requestId, "session"), 42, 42);
  assertEquals(await pendingSecond, { result: "allow", grant: "session" });
  assertEquals(port.isPending(), false);
});

Deno.test("Telegram permission prompt queues overlapping prompts", async () => {
  const port = createTelegramPermissionPromptPort(1_000);
  const ctx = fakeTurnContext();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const first = request({ requestId: "aaaaaaaa-1111-1111-1111-111111111111" });
  const second = request({ requestId: "bbbbbbbb-2222-2222-2222-222222222222", value: "/bin/ls" });

  const pendingFirst = port.prompt(first);
  const pendingSecond = port.prompt(second);
  await Promise.resolve();

  assertEquals(ctx.replies.length, 1);
  assertEquals(port.isPending(), true);

  const firstDispatch = await port.handleCallback(callbackData(first.requestId, "once"), 42, 42);
  assertEquals(firstDispatch.clearReplyMarkup, true);
  assertEquals(await pendingFirst, { result: "allow", grant: "once" });
  await Promise.resolve();

  assertEquals(ctx.replies.length, 2);

  const secondDispatch = await port.handleCallback(callbackData(second.requestId, "session"), 42, 42);
  assertEquals(secondDispatch.clearReplyMarkup, true);
  assertEquals(await pendingSecond, { result: "allow", grant: "session" });
  assertEquals(port.isPending(), false);
});

Deno.test("Telegram permission prompt denies on abort", async () => {
  const port = createTelegramPermissionPromptPort(1_000);
  const controller = new AbortController();
  const ctx = fakeTurnContext();
  port.setTurnContext({ ctx, signal: controller.signal });

  const pending = port.prompt(request());
  await Promise.resolve();
  controller.abort();

  assertEquals(await pending, { result: "deny" });
  assertEquals(port.isPending(), false);
});

Deno.test("Telegram permission prompt prefers turn signal over process shutdown signal", async () => {
  const port = createTelegramPermissionPromptPort(1_000);
  const turnController = new AbortController();
  const processController = new AbortController();
  const ctx = fakeTurnContext();
  port.setTurnContext({ ctx, signal: turnController.signal });

  const pending = port.prompt(request(), processController.signal);
  await Promise.resolve();
  assertEquals(port.isPending(), true);

  turnController.abort();
  assertEquals(await pending, { result: "deny" });
  assertEquals(port.isPending(), false);
});

Deno.test("Telegram permission prompt abortPending settles in-flight prompt", async () => {
  const port = createTelegramPermissionPromptPort(1_000);
  const ctx = fakeTurnContext();
  port.setTurnContext({ ctx, signal: new AbortController().signal });

  const pending = port.prompt(request());
  await Promise.resolve();
  port.abortPending();

  assertEquals(await pending, { result: "deny" });
  assertEquals(port.isPending(), false);
});
