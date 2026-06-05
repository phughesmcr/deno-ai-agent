// deno-lint-ignore-file camelcase -- Telegram API field names are snake_case.

import * as path from "@std/path";
import type { Api } from "grammy";
import type { Message } from "grammy/types";

import { grantBrokerReadPath, grantBrokerRunForCommands, grantBrokerWritePath } from "../permission-broker/mod.ts";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const SUPPORTED_AUDIO_EXTENSIONS = /\.(flac|m4a|mp3|oga|ogg|opus|wav|webm)$/i;

/** Audio bytes plus metadata for local transcription. */
export interface TelegramAudioItem {
  bytes: Uint8Array;
  fileName: string;
}

/** Local audio transcription boundary. */
export interface AudioTranscriber {
  transcribe(item: TelegramAudioItem, signal?: AbortSignal): Promise<string>;
}

interface CommandOutput {
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface TranscriberIo {
  makeTempDir(): Promise<string>;
  writeFile(filePath: string, bytes: Uint8Array): Promise<void>;
  remove(filePath: string): Promise<void>;
  command(command: string, options: Deno.CommandOptions): Promise<CommandOutput>;
  grantRead(filePath: string, signal?: AbortSignal): Promise<void>;
  grantWrite(filePath: string, signal?: AbortSignal): Promise<void>;
  grantRun(commands: readonly string[], signal?: AbortSignal): Promise<void>;
}

/** Configuration for the local whisper.cpp CLI transcriber. */
export interface WhisperCliTranscriberOptions {
  bin: string;
  model: string;
  language?: string;
  io?: TranscriberIo;
}

/** Thrown when Telegram audio exceeds the download/transcription limit. */
export class AudioTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`Audio is too large (${byteLength} bytes, max ${MAX_AUDIO_BYTES})`);
    this.name = "AudioTooLargeError";
  }
}

/** Thrown when a message has no supported audio attachment or transcription fails. */
export class UnsupportedAudioError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UnsupportedAudioError";
  }
}

function defaultIo(): TranscriberIo {
  return {
    makeTempDir: () => Deno.makeTempDir({ prefix: "silas-telegram-audio-" }),
    writeFile: (filePath, bytes) => Deno.writeFile(filePath, bytes),
    remove: (filePath) => Deno.remove(filePath, { recursive: true }),
    command: async (command, options) => await new Deno.Command(command, options).output(),
    grantRead: grantBrokerReadPath,
    grantWrite: grantBrokerWritePath,
    grantRun: grantBrokerRunForCommands,
  };
}

function audioExtensionFromMime(mimeType?: string): string {
  switch (mimeType) {
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
    case "audio/oga":
    case "audio/opus":
      return "ogg";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    default:
      return "ogg";
  }
}

function safeBaseName(fileName: string): string {
  return path.basename(fileName).replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

function assertAudioSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new AudioTooLargeError(bytes.byteLength);
}

function stderrText(stderr: Uint8Array): string {
  return new TextDecoder().decode(stderr).trim();
}

/** Returns a Telegram `file_id` for a voice/audio attachment, if present. */
export function extractAudioFileId(message: Message): string | undefined {
  if (message.voice?.file_id) return message.voice.file_id;
  if (message.audio?.file_id) return message.audio.file_id;

  const document = message.document;
  if (document?.mime_type?.startsWith("audio/")) return document.file_id;

  return undefined;
}

/** Returns the Telegram audio attachment kind for telemetry. */
export function telegramAudioKind(message: Message): "audio" | "document" | "voice" | undefined {
  if (message.voice?.file_id) return "voice";
  if (message.audio?.file_id) return "audio";
  if (message.document?.mime_type?.startsWith("audio/")) return "document";
  return undefined;
}

/** Returns Telegram-provided audio duration in seconds, when available. */
export function telegramAudioDuration(message: Message): number | undefined {
  return message.voice?.duration ?? message.audio?.duration;
}

/** Infers a safe filename for local transcription from Telegram metadata. */
export function inferAudioFileName(
  filePath: string,
  mimeType?: string,
  documentFileName?: string,
): string {
  if (documentFileName && SUPPORTED_AUDIO_EXTENSIONS.test(documentFileName)) {
    return safeBaseName(documentFileName);
  }

  const fromPath = filePath.split("/").pop();
  if (fromPath && SUPPORTED_AUDIO_EXTENSIONS.test(fromPath)) return safeBaseName(fromPath);

  return `telegram.${audioExtensionFromMime(mimeType)}`;
}

/** Downloads one audio attachment from a Telegram message. */
export async function downloadTelegramMessageAudio(
  api: Api,
  botToken: string,
  message: Message,
): Promise<TelegramAudioItem> {
  const fileId = extractAudioFileId(message);
  if (!fileId) throw new UnsupportedAudioError("Message has no supported audio attachment");

  const file = await api.getFile(fileId);
  if (!file.file_path) throw new UnsupportedAudioError("Telegram audio file has no path");

  const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new UnsupportedAudioError(`Failed to download Telegram audio file (${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  assertAudioSize(bytes);

  const fileName = inferAudioFileName(
    file.file_path,
    message.document?.mime_type ?? message.audio?.mime_type ?? message.voice?.mime_type,
    message.document?.file_name ?? message.audio?.file_name,
  );
  return { bytes, fileName };
}

/** Creates a local whisper.cpp CLI transcriber. */
export function createWhisperCliTranscriber(options: WhisperCliTranscriberOptions): AudioTranscriber {
  const io = options.io ?? defaultIo();
  const language = options.language ?? "auto";

  return {
    async transcribe(item, signal): Promise<string> {
      assertAudioSize(item.bytes);

      const tempDir = await io.makeTempDir();
      const audioPath = path.join(tempDir, safeBaseName(item.fileName));
      try {
        await io.grantWrite(audioPath, signal);
        await io.writeFile(audioPath, item.bytes);
        await io.grantRead(audioPath, signal);
        await io.grantRun([options.bin], signal);

        const output = await io.command(options.bin, {
          args: [
            "-m",
            options.model,
            "-f",
            audioPath,
            "-np",
            "-nt",
            "-l",
            language,
          ],
          stdout: "piped",
          stderr: "piped",
          signal,
        });
        if (output.code !== 0) {
          const detail = stderrText(output.stderr);
          throw new UnsupportedAudioError(
            `Whisper transcription failed (${output.code})${detail ? `: ${detail}` : ""}`,
          );
        }

        const transcript = new TextDecoder().decode(output.stdout).trim();
        if (!transcript) throw new UnsupportedAudioError("Whisper produced an empty transcript");
        return transcript;
      } finally {
        await io.remove(tempDir);
      }
    },
  };
}
