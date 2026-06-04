// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import type { Message } from "grammy/types";
import { assertEquals } from "jsr:@std/assert@1";

import { parseTelegramUserTurn } from "../../src/telegram/parse-user-turn.ts";
import { DEFAULT_IMAGE_PROMPT } from "../../src/telegram/telegram-image.ts";
import type { TelegramContext } from "../../src/telegram/telegram.ts";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function fakeCtx(message: Message): TelegramContext {
  return {
    message,
    api: {
      getFile: () => Promise.resolve({ file_path: "photos/test.jpg" }),
    },
    // deno-lint-ignore no-explicit-any
  } as any as TelegramContext;
}

Deno.test({
  name: "parseTelegramUserTurn returns text-only input",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const input = await parseTelegramUserTurn(
    fakeCtx({ text: "hello" } as Message),
    {} as import("@lmstudio/sdk").LMStudioClient,
    "token",
  );
  assertEquals(input, { text: "hello" });
});

Deno.test({
  name: "parseTelegramUserTurn downloads photo and prepares images",
  sanitizeOps: false,
  sanitizeResources: false,
  ignore: !Deno.env.get("LMSTUDIO_IMAGE_TEST"),
}, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(Uint8Array.from(atob(TINY_PNG_BASE64), (c) => c.charCodeAt(0))),
    );

  try {
    const { LMStudioClient } = await import("@lmstudio/sdk");
    const message = {
      photo: [{ file_id: "p1", width: 100, height: 100, file_size: 70 }],
      caption: "what is this",
    } as Message;
    const input = await parseTelegramUserTurn(
      fakeCtx(message),
      new LMStudioClient(),
      "token",
    );
    assertEquals(input?.text, "what is this");
    assertEquals(input?.images?.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("parseTelegramUserTurn returns null for unsupported messages", async () => {
  const input = await parseTelegramUserTurn(
    fakeCtx({ sticker: { file_id: "s1" } } as Message),
    {} as import("@lmstudio/sdk").LMStudioClient,
    "token",
  );
  assertEquals(input, null);
});

Deno.test({
  name: "parseTelegramUserTurn uses default prompt without caption",
  sanitizeOps: false,
  sanitizeResources: false,
  ignore: !Deno.env.get("LMSTUDIO_IMAGE_TEST"),
}, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(Uint8Array.from(atob(TINY_PNG_BASE64), (c) => c.charCodeAt(0))),
    );

  try {
    const { LMStudioClient } = await import("@lmstudio/sdk");
    const message = {
      photo: [{ file_id: "p1", width: 100, height: 100, file_size: 70 }],
    } as Message;
    const input = await parseTelegramUserTurn(
      fakeCtx(message),
      new LMStudioClient(),
      "token",
    );
    assertEquals(input?.text, DEFAULT_IMAGE_PROMPT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
