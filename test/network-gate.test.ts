import { assertEquals, assertRejects } from "jsr:@std/assert@1";

import { type ApprovalGate, createAutoApprovalGate, createDenyApprovalGate } from "../src/approval.ts";
import { NetworkGate } from "../src/network-gate.ts";

Deno.test("NetworkGate allows configured internal hosts without approval", async () => {
  let calls = 0;
  const gate = new NetworkGate({
    approvalGate: createDenyApprovalGate("should not be called"),
    sessionId: () => "session-1",
    turnId: () => "turn-1",
    internalHosts: ["127.0.0.1:1234"],
    fetcher: (input: string | URL | Request) => {
      calls++;
      return Promise.resolve(new Response(String(input)));
    },
  });

  const response = await gate.fetch("http://127.0.0.1:1234/v1/models");

  assertEquals(await response.text(), "http://127.0.0.1:1234/v1/models");
  assertEquals(calls, 1);
});

Deno.test("NetworkGate denies unknown hosts when approval is denied", async () => {
  let calls = 0;
  const gate = new NetworkGate({
    approvalGate: createDenyApprovalGate("network denied"),
    sessionId: () => "session-1",
    turnId: () => "turn-1",
    fetcher: () => {
      calls++;
      return Promise.resolve(new Response("unexpected"));
    },
  });

  await assertRejects(
    () => gate.fetch("https://example.com/data.json"),
    Error,
    "network denied",
  );
  assertEquals(calls, 0);
});

Deno.test("NetworkGate approves unknown hosts before fetching", async () => {
  const requests: string[] = [];
  const approvalGate: ApprovalGate = {
    requestApproval(request): Promise<{ approved: true; decidedAt: string; reason: string }> {
      requests.push(`${request.operation}:${request.target}`);
      return Promise.resolve({
        approved: true,
        decidedAt: new Date(0).toISOString(),
        reason: "approved",
      });
    },
  };
  const gate = new NetworkGate({
    approvalGate,
    sessionId: () => "session-1",
    turnId: () => "turn-1",
    fetcher: () => Promise.resolve(new Response("ok")),
  });

  const response = await gate.fetch("https://api.example.com/v1");

  assertEquals(await response.text(), "ok");
  assertEquals(requests, ["network:https://api.example.com"]);
});

Deno.test("NetworkGate accepts an auto-approval gate", async () => {
  const gate = new NetworkGate({
    approvalGate: createAutoApprovalGate(),
    sessionId: () => "session-1",
    turnId: () => "turn-1",
    fetcher: () => Promise.resolve(new Response("ok")),
  });

  assertEquals(await (await gate.fetch(new URL("https://example.org"))).text(), "ok");
});
