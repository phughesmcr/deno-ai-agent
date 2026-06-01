# OpenTelemetry (no Docker)

## Web UI: Jaeger (traces)

One-time install (binary next to `otelcol`):

```sh
deno task otel:jaeger:install
```

Three terminals:

```sh
# 1 — Jaeger UI at http://localhost:16686
deno task otel:jaeger

# 2 — receives from Deno on :4318, forwards traces to Jaeger on :4317
deno task otel:collector:jaeger

# 3 — bot
deno task start:otel
```

Send a Telegram message, then open **http://localhost:16686** → **Search** → Service **`deno-ai-agent`**.

Spans to look for: `telegram.message`, `lmstudio.act`, and nested `fetch` spans.

Jaeger is **traces only**. Metrics and logs still appear in terminal 2 (`debug` exporter).

Install the **contrib** collector once (required for token redaction; the core `otelcol` build lacks the `transform` processor):

```sh
deno task otel:collector:install
```

If you see `unknown type: "transform"`, re-run the install task to replace `otel/otelcol` with the contrib binary.

Telegram bot tokens in trace `url.full` are redacted to `/bot***` in the collector before export.

## No collector (stderr)

```sh
deno task start:otel:console
```

## Ports

| Port  | What |
| ----- | ---- |
| 4318  | Collector OTLP HTTP — Deno exports here |
| 4317  | Jaeger OTLP gRPC — collector forwards traces here |
| 16686 | **Jaeger web UI** |

`http://localhost:4318` in a browser returns 404 — OTLP is POST-only, not a dashboard.

## All-in-one UI (traces + metrics + logs)

Without Docker, full OSS UI means more services (ClickHouse, Postgres, Redis for Uptrace, or Grafana + Tempo + Loki + Prometheus). For this bot, Jaeger covers the main debugging path.
