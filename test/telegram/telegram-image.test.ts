// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import type { Message } from "grammy/types";
import { assertEquals } from "jsr:@std/assert@1";

import { extractImageFileId, inferImageFileName } from "../../src/telegram/telegram-image.ts";

Deno.test("extractImageFileId prefers largest photo", () => {
  const message = {
    photo: [
      { file_id: "small", width: 90, height: 90, file_size: 100 },
      { file_id: "large", width: 1280, height: 720, file_size: 5000 },
    ],
  } as Message;
  assertEquals(extractImageFileId(message), "large");
});

Deno.test("extractImageFileId accepts image documents", () => {
  const message = {
    document: {
      file_id: "doc-1",
      mime_type: "image/png",
      file_name: "scan.png",
    },
  } as Message;
  assertEquals(extractImageFileId(message), "doc-1");
});

Deno.test("extractImageFileId rejects non-image documents", () => {
  const message = {
    document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "x.pdf" },
  } as Message;
  assertEquals(extractImageFileId(message), undefined);
});

Deno.test("inferImageFileName uses document file_name", () => {
  assertEquals(
    inferImageFileName("photos/file_1.jpg", "image/jpeg", "holiday.jpeg"),
    "holiday.jpeg",
  );
});

Deno.test("inferImageFileName falls back from mime", () => {
  assertEquals(inferImageFileName("photos/file", "image/webp"), "telegram.webp");
});
