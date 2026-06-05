import { z } from "zod/v3";

function envRecord(keys: readonly string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, Deno.env.get(key)]));
}

function optionalBoolean(defaultValue: boolean): z.ZodEffects<z.ZodOptional<z.ZodString>, boolean, string | undefined> {
  return z.string().optional().transform((value) => {
    if (value === undefined || value === "") return defaultValue;
    return value !== "false" && value !== "0";
  });
}

function optionalPositiveInteger(
  name: string,
  defaultValue: number,
): z.ZodEffects<z.ZodOptional<z.ZodString>, number, string | undefined> {
  return z.string().optional().transform((value) => {
    if (value === undefined || value === "") return defaultValue;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
    return parsed;
  });
}

const appBaseEnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is not set"),
  TELEGRAM_ADMIN_ID: z.string().min(1, "TELEGRAM_ADMIN_ID is not set").transform((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error("TELEGRAM_ADMIN_ID must be a number");
    return parsed;
  }),
  TELEGRAM_BOT_ID: z.string().optional(),
  MODEL: z.string().min(1, "MODEL is not set"),
  CONTEXT_LENGTH: z.string().min(1, "CONTEXT_LENGTH is not set").transform((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("CONTEXT_LENGTH is not a number");
    if (parsed <= 0) throw new Error("CONTEXT_LENGTH must be greater than 0");
    return parsed;
  }),
  BOT_NAME: z.string().optional().default("Silas"),
  WORKSPACE_PATH: z.string().optional().default(".silas"),
  OTEL_DENO: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().optional().default("deno-ai-agent"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional().default("http://localhost:4318"),
  OTEL_EXPORTER_OTLP_PROTOCOL: z.string().optional().default("http/protobuf"),
  LOG_LEVEL: z.string().optional(),
  DENO_PERMISSION_BROKER_PATH: z.string().optional(),
  SILAS_PERMISSION_CONTROL_PATH: z.string().optional(),
  PERMISSION_PROMPT_TIMEOUT_MS: optionalPositiveInteger("PERMISSION_PROMPT_TIMEOUT_MS", 120_000),
  WHISPER_CPP_BIN: z.string().optional(),
  WHISPER_CPP_MODEL: z.string().optional(),
  WHISPER_CPP_LANGUAGE: z.string().optional().default("auto"),
  TELEGRAM_AUDIO_TRANSCRIPTION: optionalBoolean(false),
});

const appEnvSchema = appBaseEnvSchema.transform((env) => {
  const audioEnabled = env.TELEGRAM_AUDIO_TRANSCRIPTION || Boolean(env.WHISPER_CPP_BIN);
  if (audioEnabled && !env.WHISPER_CPP_MODEL) {
    throw new Error("WHISPER_CPP_MODEL is required when audio transcription is enabled");
  }
  return {
    ...env,
    TELEGRAM_AUDIO_TRANSCRIPTION: audioEnabled,
  };
});

const appEnvKeys = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ADMIN_ID",
  "TELEGRAM_BOT_ID",
  "MODEL",
  "CONTEXT_LENGTH",
  "BOT_NAME",
  "WORKSPACE_PATH",
  "OTEL_DENO",
  "OTEL_SERVICE_NAME",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "LOG_LEVEL",
  "DENO_PERMISSION_BROKER_PATH",
  "SILAS_PERMISSION_CONTROL_PATH",
  "PERMISSION_PROMPT_TIMEOUT_MS",
  "WHISPER_CPP_BIN",
  "WHISPER_CPP_MODEL",
  "WHISPER_CPP_LANGUAGE",
  "TELEGRAM_AUDIO_TRANSCRIPTION",
] as const;

const telegramEnvSchema = appBaseEnvSchema.pick({
  TELEGRAM_BOT_TOKEN: true,
  TELEGRAM_ADMIN_ID: true,
  TELEGRAM_BOT_ID: true,
});

const telegramEnvKeys = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ADMIN_ID",
  "TELEGRAM_BOT_ID",
] as const;

const reasoningEnvSchema = z.object({
  REASONING_ENABLED: optionalBoolean(true),
  REASONING_ACT_PARSING: optionalBoolean(false),
  REASONING_START: z.string().optional().default("<think>"),
  REASONING_END: z.string().optional().default("</think>"),
  KEEP_THINKING: optionalBoolean(true),
});

const reasoningEnvKeys = [
  "REASONING_ENABLED",
  "REASONING_ACT_PARSING",
  "REASONING_START",
  "REASONING_END",
  "KEEP_THINKING",
] as const;

const brokerEnvSchema = z.object({
  SILAS_BROKER_LISTEN_PATH: z.string().optional(),
  DENO_PERMISSION_BROKER_PATH: z.string().optional(),
  SILAS_PERMISSION_CONTROL_PATH: z.string().min(1, "SILAS_PERMISSION_CONTROL_PATH is not set"),
  WORKSPACE_PATH: z.string().optional().default(".silas"),
  SILAS_PROJECT_ROOT: z.string().optional(),
  DENO_DIR: z.string().optional(),
  HOME: z.string().optional(),
  PERMISSION_PROMPT_TIMEOUT_MS: optionalPositiveInteger("PERMISSION_PROMPT_TIMEOUT_MS", 120_000),
  SILAS_PERMISSION_RUN_PROMPTS: z.string().optional().transform((value) => value === "1"),
}).transform((env) => {
  const brokerPath = env.SILAS_BROKER_LISTEN_PATH ?? env.DENO_PERMISSION_BROKER_PATH;
  if (!brokerPath) throw new Error("SILAS_BROKER_LISTEN_PATH is not set");
  return { ...env, brokerPath };
});

const brokerEnvKeys = [
  "SILAS_BROKER_LISTEN_PATH",
  "DENO_PERMISSION_BROKER_PATH",
  "SILAS_PERMISSION_CONTROL_PATH",
  "WORKSPACE_PATH",
  "SILAS_PROJECT_ROOT",
  "DENO_DIR",
  "HOME",
  "PERMISSION_PROMPT_TIMEOUT_MS",
  "SILAS_PERMISSION_RUN_PROMPTS",
] as const;

/** Main process runtime configuration parsed from environment variables. */
export type AppConfig = z.infer<typeof appEnvSchema>;

/** Telegram runtime configuration parsed from environment variables. */
export type TelegramConfig = z.infer<typeof telegramEnvSchema>;

/** Model reasoning configuration parsed from environment variables. */
export type ReasoningEnvConfig = z.infer<typeof reasoningEnvSchema>;

/** Permission broker environment parsed from environment variables. */
export type BrokerEnvConfig = z.infer<typeof brokerEnvSchema>;

/** Loads main process runtime configuration. */
export function loadAppConfig(): AppConfig {
  return appEnvSchema.parse(envRecord(appEnvKeys));
}

/** Loads Telegram runtime configuration. */
export function loadTelegramConfig(): TelegramConfig {
  return telegramEnvSchema.parse(envRecord(telegramEnvKeys));
}

/** Loads model reasoning environment configuration. */
export function loadReasoningEnvConfig(): ReasoningEnvConfig {
  return reasoningEnvSchema.parse(envRecord(reasoningEnvKeys));
}

/** Loads permission broker runtime configuration. */
export function loadBrokerEnvConfig(): BrokerEnvConfig {
  return brokerEnvSchema.parse(envRecord(brokerEnvKeys));
}
