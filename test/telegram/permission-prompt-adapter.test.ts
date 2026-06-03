// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.
import { assertEquals } from "jsr:@std/assert@1";

import type { PermissionPromptRequest } from "../../src/permission-broker/mod.ts";
import { encodePermissionCallback, toShortRequestId } from "../../src/telegram/permission-callback.ts";
import { createTelegramPermissionPromptPort } from "../../src/telegram/grammy-permission-prompt-adapter.ts";

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

  const handled = await port.handleCallback(callbackData(prompt.requestId, "session"), 42, 42);

  assertEquals(handled, true);
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

  const handled = await port.handleCallback(callbackData(prompt.requestId, "once"), 7, 42);

  assertEquals(handled, true);
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

  const handled = await port.handleCallback(callbackData("87654321-1234-1234-1234-123456789abc", "once"), 42, 42);

  assertEquals(handled, true);
  assertEquals(port.isPending(), true);

  await port.handleCallback(callbackData(prompt.requestId, "once"), 42, 42);
  assertEquals(await pending, { result: "allow", grant: "once" });
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
