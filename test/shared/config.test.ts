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
    },
    () => {
      const config = loadAppConfig();
      assertEquals(config.TELEGRAM_ADMIN_ID, 42);
      assertEquals(config.CONTEXT_LENGTH, 65536);
      assertEquals(config.BOT_NAME, "Silas");
      assertEquals(config.WORKSPACE_PATH, ".silas");
      assertEquals(config.PERMISSION_PROMPT_TIMEOUT_MS, 120_000);
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
