/**
 * Phase 0 audit-derived allowlists (tune with `DENO_AUDIT_PERMISSIONS` on `deno task start`).
 * @internal
 */

/** Audit-derived hosts allowed without Telegram prompt during bootstrap and steady state. */
export const BOOTSTRAP_NET_HOSTS = [
  "api.telegram.org:443",
  "127.0.0.1:1234",
  "localhost:1234",
  "127.0.0.1:4318",
  "localhost:4318",
  "127.0.0.1:4317",
  "localhost:4317",
  "deno.land:443",
  "jsr.io:443",
  "esm.sh:443",
  "cdn.jsdelivr.net:443",
  "raw.githubusercontent.com:443",
  "gist.githubusercontent.com:443",
  "dl.deno.land:443",
] as const;

/** Env vars read at startup and during normal operation. */
export const BOOTSTRAP_ENV_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ADMIN_ID",
  "TELEGRAM_BOT_ID",
  "MODEL",
  "CONTEXT_LENGTH",
  "BOT_NAME",
  "WORKSPACE_PATH",
  "LOG_LEVEL",
  "OTEL_DENO",
  "OTEL_SERVICE_NAME",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "DENO_DIR",
  "DENO_PERMISSION_BROKER_PATH",
  "SILAS_BROKER_LISTEN_PATH",
  "SILAS_PERMISSION_CONTROL_PATH",
  "SILAS_PROJECT_ROOT",
  "SILAS_PERMISSION_RUN_PROMPTS",
  "PERMISSION_PROMPT_TIMEOUT_MS",
  "HOME",
  "USER",
  "SHELL",
  "PATH",
  "TMPDIR",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "TERM_SESSION_ID",
  "CI",
  "TEAMCITY_VERSION",
  "GITHUB_ACTIONS",
  "NODE_ENV",
  "WS_NO_BUFFER_UTIL",
  "WS_NO_UTF_8_VALIDATE",
] as const;

/** Import hosts aligned with Deno default trusted registries. */
export const TRUSTED_IMPORT_HOSTS = [
  "deno.land",
  "jsr.io",
  "esm.sh",
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
] as const;
