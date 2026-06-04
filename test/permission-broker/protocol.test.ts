import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  formatBrokerResponse,
  normalizeBrokerValue,
  parseBrokerRequest,
} from "../../src/permission-broker/protocol.ts";
import { parseControlMessage } from "../../src/permission-broker/control-protocol.ts";

Deno.test("normalizeBrokerValue unwraps JSON string", () => {
  assertEquals(normalizeBrokerValue('"./README.md"'), "./README.md");
});

Deno.test("parseBrokerRequest and formatBrokerResponse round-trip id", () => {
  const line = JSON.stringify({
    v: 1,
    pid: 99,
    id: 7,
    datetime: "2025-01-01T00:00:00.000Z",
    permission: "read",
    value: "./file.txt",
  });
  const request = parseBrokerRequest(line);
  assertEquals(request.id, 7);
  const response = formatBrokerResponse({ id: 7, result: "allow" });
  assertEquals(JSON.parse(response.trim()), { id: 7, result: "allow" });
});

Deno.test("parseBrokerRequest normalizes omitted value to null", () => {
  const line = JSON.stringify({
    v: 1,
    pid: 99,
    id: 8,
    datetime: "2025-01-01T00:00:00.000Z",
    permission: "env",
  });
  assertEquals(parseBrokerRequest(line).value, null);
});

Deno.test("parseBrokerRequest rejects invalid json", () => {
  assertThrows(() => parseBrokerRequest("not-json"), Error);
});

Deno.test("parseBrokerRequest rejects malformed request shape", () => {
  assertThrows(() =>
    parseBrokerRequest(JSON.stringify({
      v: "1",
      pid: 99,
      id: 7,
      datetime: "2025-01-01T00:00:00.000Z",
      permission: "read",
    }))
  );
});

Deno.test("parseControlMessage rejects malformed control message shape", () => {
  assertThrows(() =>
    parseControlMessage(JSON.stringify({
      type: "decision",
      requestId: "request-1",
      result: "maybe",
    }))
  );
});
