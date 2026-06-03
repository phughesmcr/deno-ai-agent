import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import {
  sendModelTextReply,
  type TelegramReplyOptions,
  type TelegramReplySender,
} from "../src/telegram/model-reply.ts";

interface ReplyCall {
  text: string;
  options?: TelegramReplyOptions;
}

class FakeSender implements TelegramReplySender {
  readonly calls: ReplyCall[] = [];
  failures: unknown[] = [];

  reply(text: string, options?: TelegramReplyOptions): Promise<void> {
    this.calls.push({ text, options });
    const failure = this.failures.shift();
    return failure ? Promise.reject(failure) : Promise.resolve();
  }
}

function telegramError(message: string, code: number): Error & { error_code: number } {
  const error = new Error(message) as Error & { error_code: number };
  error.error_code = code;
  return error;
}

Deno.test("sendModelTextReply sends MarkdownV2 with reply parameters", async () => {
  const sender = new FakeSender();

  await sendModelTextReply(sender, "hello.world", 42, 99);

  assertEquals(sender.calls, [
    {
      text: "hello\\.world",
      options: {
        reply_parameters: { message_id: 42 },
        message_thread_id: 99,
        parse_mode: "MarkdownV2",
      },
    },
  ]);
});

Deno.test("sendModelTextReply formats thinking per reply chunk", async () => {
  const sender = new FakeSender();

  await sendModelTextReply(sender, ["<redacted_thinking>a</redacted_thinking>First", "<redacted_thinking>b</redacted_thinking>Second"], 42, 99);

  assertEquals(sender.calls, [
    {
      text: "**>a||\n\nFirst\n\n**>b||\n\nSecond",
      options: {
        reply_parameters: { message_id: 42 },
        message_thread_id: 99,
        parse_mode: "MarkdownV2",
      },
    },
  ]);
});

Deno.test("sendModelTextReply falls back to plain text on Telegram 400", async () => {
  const sender = new FakeSender();
  sender.failures = [telegramError("bad markdown", 400)];

  await sendModelTextReply(sender, "<redacted_thinking>secret</redacted_thinking>Hello *world*", 7, 11);

  assertEquals(sender.calls, [
    {
      text: "**>secret||\n\nHello \\*world\\*",
      options: {
        reply_parameters: { message_id: 7 },
        message_thread_id: 11,
        parse_mode: "MarkdownV2",
      },
    },
    {
      text: "Hello *world*",
      options: {
        reply_parameters: { message_id: 7 },
        message_thread_id: 11,
      },
    },
  ]);
});

Deno.test("sendModelTextReply plain fallback strips thinking per reply chunk", async () => {
  const sender = new FakeSender();
  sender.failures = [telegramError("bad markdown", 400)];

  await sendModelTextReply(sender, ["<redacted_thinking>a</redacted_thinking>First", "<redacted_thinking>b</redacted_thinking>Second"], 7, 11);

  assertEquals(sender.calls, [
    {
      text: "**>a||\n\nFirst\n\n**>b||\n\nSecond",
      options: {
        reply_parameters: { message_id: 7 },
        message_thread_id: 11,
        parse_mode: "MarkdownV2",
      },
    },
    {
      text: "First\n\nSecond",
      options: {
        reply_parameters: { message_id: 7 },
        message_thread_id: 11,
      },
    },
  ]);
});

Deno.test("sendModelTextReply rethrows non-400 reply failures", async () => {
  const sender = new FakeSender();
  sender.failures = [telegramError("telegram unavailable", 500)];

  await assertRejects(
    () => sendModelTextReply(sender, "hello", 1, 2),
    Error,
    "telegram unavailable",
  );
  assertEquals(sender.calls.length, 1);
});
