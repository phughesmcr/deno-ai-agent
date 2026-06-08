import { assertEquals } from "jsr:@std/assert@1";

import { createBrokerCapabilityPromptPort } from "../../src/app/broker-capability-prompt.ts";
import type { CapabilityDecisionResult, CapabilityRequest } from "../../src/core/mod.ts";
import type { PermissionPromptRequest } from "../../src/permission-broker/mod.ts";

const PROMPT: PermissionPromptRequest = {
  requestId: "prompt-1",
  brokerId: 7,
  permission: "run",
  value: "deno task test",
};

Deno.test("broker capability prompt maps broker prompts to broker_permission capabilities", async () => {
  const requests: CapabilityRequest[] = [];
  const port = createBrokerCapabilityPromptPort({
    getSessionId: () => "session-1",
    getWorkId: () => "work-1",
    authorizer: {
      decide(request): Promise<CapabilityDecisionResult> {
        requests.push(request);
        return Promise.resolve({
          allowed: true,
          reason: "approved",
          scope: "once",
          source: "prompt",
          grant: "once",
        });
      },
    },
  });

  assertEquals(await port.prompt(PROMPT), { result: "allow" });
  assertEquals(requests[0], {
    id: "prompt-1",
    sessionId: "session-1",
    workId: "work-1",
    source: "broker_permission",
    capability: { kind: "broker_permission", target: "deno task test", action: "run" },
    risk: "high",
    summary: "Deno permission broker request",
    timeoutMs: 120_000,
    display: {
      action: "run",
      target: "deno task test",
    },
  });
});

Deno.test("broker capability prompt mirrors session grants back to the broker", async () => {
  const port = createBrokerCapabilityPromptPort({
    getSessionId: () => "session-1",
    authorizer: {
      decide(): Promise<CapabilityDecisionResult> {
        return Promise.resolve({
          allowed: true,
          reason: "approved",
          scope: "session",
          source: "prompt",
          grant: "session",
        });
      },
    },
  });

  assertEquals(await port.prompt(PROMPT), { result: "allow", grant: "session" });
});

Deno.test("broker capability prompt denies closed when authorizer denies or throws", async () => {
  const denied = createBrokerCapabilityPromptPort({
    getSessionId: () => "session-1",
    authorizer: {
      decide(): Promise<CapabilityDecisionResult> {
        return Promise.resolve({
          allowed: false,
          reason: "missing_telegram_turn",
          scope: "once",
          source: "prompt",
        });
      },
    },
  });
  assertEquals(await denied.prompt(PROMPT), { result: "deny" });

  const thrown = createBrokerCapabilityPromptPort({
    getSessionId: () => "session-1",
    authorizer: {
      decide(): Promise<CapabilityDecisionResult> {
        return Promise.reject(new Error("no turn"));
      },
    },
  });
  assertEquals(await thrown.prompt(PROMPT), { result: "deny" });
});
