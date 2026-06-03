import { metrics } from "@opentelemetry/api";

import { SERVICE_NAME, SERVICE_VERSION } from "../shared/otel.ts";

const meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);

const telegramMessagesTotal = meter.createCounter("telegram.messages", {
  description: "Telegram messages handled",
});

/** Records one handled Telegram message. */
export function recordTelegramMessage(outcome: "error" | "ok", skipped: boolean): void {
  telegramMessagesTotal.add(1, { outcome, skipped: String(skipped) });
}
