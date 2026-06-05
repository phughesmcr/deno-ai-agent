// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import type { Message } from "grammy/types";
import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import {
  AudioTooLargeError,
  createWhisperCliTranscriber,
  downloadTelegramMessageAudio,
  extractAudioFileId,
  inferAudioFileName,
  UnsupportedAudioError,
} from "../../src/telegram/telegram-audio.ts";

Deno.test("extractAudioFileId accepts voice messages", () => {
  const message = {
    voice: { file_id: "voice-1", duration: 5 },
  } as Message;
  assertEquals(extractAudioFileId(message), "voice-1");
});

Deno.test("extractAudioFileId accepts audio messages", () => {
  const message = {
    audio: { file_id: "audio-1", duration: 5 },
  } as Message;
  assertEquals(extractAudioFileId(message), "audio-1");
});

Deno.test("extractAudioFileId accepts audio documents", () => {
  const message = {
    document: { file_id: "doc-1", mime_type: "audio/ogg", file_name: "note.ogg" },
  } as Message;
  assertEquals(extractAudioFileId(message), "doc-1");
});

Deno.test("extractAudioFileId rejects non-audio documents", () => {
  const message = {
    document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "x.pdf" },
  } as Message;
  assertEquals(extractAudioFileId(message), undefined);
});

Deno.test("inferAudioFileName uses document file name", () => {
  assertEquals(
    inferAudioFileName("documents/file", "audio/ogg", "memo.ogg"),
    "memo.ogg",
  );
});

Deno.test("inferAudioFileName falls back from Telegram file path", () => {
  assertEquals(inferAudioFileName("voice/file_12.mp3"), "file_12.mp3");
});

Deno.test("inferAudioFileName falls back from MIME type", () => {
  assertEquals(inferAudioFileName("voice/file", "audio/mpeg"), "telegram.mp3");
});

Deno.test("downloadTelegramMessageAudio rejects missing Telegram file path", async () => {
  const api = {
    getFile: () => Promise.resolve({}),
  };

  await assertRejects(
    () =>
      downloadTelegramMessageAudio(
        api as unknown as Parameters<typeof downloadTelegramMessageAudio>[0],
        "token",
        { voice: { file_id: "v1", duration: 1 } } as Message,
      ),
    UnsupportedAudioError,
    "Telegram audio file has no path",
  );
});

Deno.test("downloadTelegramMessageAudio rejects oversized downloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response(new Uint8Array(20 * 1024 * 1024 + 1)));
  const api = {
    getFile: () => Promise.resolve({ file_path: "voice/file_1.ogg" }),
  };

  try {
    await assertRejects(
      () =>
        downloadTelegramMessageAudio(
          api as unknown as Parameters<typeof downloadTelegramMessageAudio>[0],
          "token",
          { voice: { file_id: "v1", duration: 1 } } as Message,
        ),
      AudioTooLargeError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("whisper transcriber passes CLI args and trims output", async () => {
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const removed: string[] = [];
  let commandName = "";
  let commandArgs: string[] = [];

  const transcriber = createWhisperCliTranscriber({
    bin: "whisper-cli",
    model: "/models/ggml-base.en.bin",
    language: "auto",
    io: {
      makeTempDir: () => Promise.resolve("/tmp/silas-audio"),
      writeFile: (path, bytes) => {
        writes.push({ path, bytes });
        return Promise.resolve();
      },
      remove: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
      command: (command, options) => {
        commandName = command;
        commandArgs = [...options.args ?? []];
        return Promise.resolve({
          code: 0,
          stdout: new TextEncoder().encode(" hello world \n"),
          stderr: new Uint8Array(),
        });
      },
      grantRead: () => Promise.resolve(),
      grantWrite: () => Promise.resolve(),
      grantRun: () => Promise.resolve(),
    },
  });

  const transcript = await transcriber.transcribe({
    bytes: Uint8Array.of(1, 2, 3),
    fileName: "memo.ogg",
  });

  assertEquals(transcript, "hello world");
  assertEquals(writes, [{ path: "/tmp/silas-audio/memo.ogg", bytes: Uint8Array.of(1, 2, 3) }]);
  assertEquals(commandName, "whisper-cli");
  assertEquals(commandArgs, [
    "-m",
    "/models/ggml-base.en.bin",
    "-f",
    "/tmp/silas-audio/memo.ogg",
    "-np",
    "-nt",
    "-l",
    "auto",
  ]);
  assertEquals(removed, ["/tmp/silas-audio"]);
});

Deno.test("whisper transcriber throws on empty transcript and deletes temp directory", async () => {
  const removed: string[] = [];
  const transcriber = createWhisperCliTranscriber({
    bin: "whisper-cli",
    model: "/models/ggml-base.en.bin",
    io: {
      makeTempDir: () => Promise.resolve("/tmp/silas-audio"),
      writeFile: () => Promise.resolve(),
      remove: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
      command: () =>
        Promise.resolve({
          code: 0,
          stdout: new TextEncoder().encode("\n"),
          stderr: new Uint8Array(),
        }),
      grantRead: () => Promise.resolve(),
      grantWrite: () => Promise.resolve(),
      grantRun: () => Promise.resolve(),
    },
  });

  await assertRejects(
    () => transcriber.transcribe({ bytes: Uint8Array.of(1), fileName: "memo.ogg" }),
    UnsupportedAudioError,
    "Whisper produced an empty transcript",
  );
  assertEquals(removed, ["/tmp/silas-audio"]);
});

Deno.test("whisper transcriber throws on failed command", async () => {
  const transcriber = createWhisperCliTranscriber({
    bin: "whisper-cli",
    model: "/models/ggml-base.en.bin",
    io: {
      makeTempDir: () => Promise.resolve("/tmp/silas-audio"),
      writeFile: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      command: () =>
        Promise.resolve({
          code: 2,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("bad input"),
        }),
      grantRead: () => Promise.resolve(),
      grantWrite: () => Promise.resolve(),
      grantRun: () => Promise.resolve(),
    },
  });

  await assertRejects(
    () => transcriber.transcribe({ bytes: Uint8Array.of(1), fileName: "memo.ogg" }),
    UnsupportedAudioError,
    "Whisper transcription failed (2): bad input",
  );
});

Deno.test("whisper transcriber rejects oversized audio", async () => {
  const transcriber = createWhisperCliTranscriber({
    bin: "whisper-cli",
    model: "/models/ggml-base.en.bin",
  });

  await assertRejects(
    () => transcriber.transcribe({ bytes: new Uint8Array(20 * 1024 * 1024 + 1), fileName: "memo.ogg" }),
    AudioTooLargeError,
  );
});
