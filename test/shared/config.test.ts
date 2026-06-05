import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import { loadAppConfig, loadReasoningEnvConfig, loadTelegramConfig } from "../../src/shared/config.ts";
import { withEnv } from "../_env.ts";

Deno.test("loadAppConfig applies defaults and parses numbers", async () => {
  await withEnv(
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ADMIN_ID: "42",
      TELEGRAM_BOT_ID: undefined,
      MODEL: "qwen3.6-27b",
      CONTEXT_LENGTH: "65536",
      BOT_NAME: undefined,
      WORKSPACE_PATH: undefined,
      PERMISSION_PROMPT_TIMEOUT_MS: undefined,
      WHISPER_CPP_BIN: undefined,
      WHISPER_CPP_MODEL: undefined,
      WHISPER_CPP_LANGUAGE: undefined,
      TELEGRAM_AUDIO_TRANSCRIPTION: undefined,
    },
    () => {
      const config = loadAppConfig();
      assertEquals(config.TELEGRAM_ADMIN_ID, 42);
      assertEquals(config.CONTEXT_LENGTH, 65536);
      assertEquals(config.BOT_NAME, "Silas");
      assertEquals(config.WORKSPACE_PATH, ".silas");
      assertEquals(config.PERMISSION_PROMPT_TIMEOUT_MS, 120_000);
      assertEquals(config.TELEGRAM_AUDIO_TRANSCRIPTION, false);
      assertEquals(config.WHISPER_CPP_LANGUAGE, "auto");
    },
  );
});

Deno.test("loadAppConfig enables audio transcription when whisper bin and model are set", async () => {
  await withEnv(
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ADMIN_ID: "42",
      MODEL: "qwen3.6-27b",
      CONTEXT_LENGTH: "65536",
      WHISPER_CPP_BIN: "whisper-cli",
      WHISPER_CPP_MODEL: "/models/ggml-base.en.bin",
      WHISPER_CPP_LANGUAGE: "en",
      TELEGRAM_AUDIO_TRANSCRIPTION: undefined,
    },
    () => {
      const config = loadAppConfig();
      assertEquals(config.TELEGRAM_AUDIO_TRANSCRIPTION, true);
      assertEquals(config.WHISPER_CPP_BIN, "whisper-cli");
      assertEquals(config.WHISPER_CPP_MODEL, "/models/ggml-base.en.bin");
      assertEquals(config.WHISPER_CPP_LANGUAGE, "en");
    },
  );
});

Deno.test("loadAppConfig rejects whisper bin without model when transcription enabled", async () => {
  await withEnv(
    {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_ADMIN_ID: "42",
      MODEL: "qwen3.6-27b",
      CONTEXT_LENGTH: "65536",
      WHISPER_CPP_BIN: "whisper-cli",
      WHISPER_CPP_MODEL: undefined,
      TELEGRAM_AUDIO_TRANSCRIPTION: undefined,
    },
    () => {
      assertThrows(() => loadAppConfig(), Error, "WHISPER_CPP_MODEL is required when audio transcription is enabled");
    },
  );
});

Deno.test("loadTelegramConfig rejects invalid admin id", async () => {
  await withEnv({ TELEGRAM_BOT_TOKEN: "token", TELEGRAM_ADMIN_ID: "not-a-number" }, () => {
    assertThrows(() => loadTelegramConfig(), Error, "TELEGRAM_ADMIN_ID must be a number");
  });
});

Deno.test("loadReasoningEnvConfig defaults act parsing off", async () => {
  await withEnv({ REASONING_ACT_PARSING: undefined }, () => {
    assertEquals(loadReasoningEnvConfig().REASONING_ACT_PARSING, false);
  });
});
