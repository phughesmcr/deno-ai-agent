import type { ChatMessageData } from "@lmstudio/sdk";
import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import { parseSessionFile, SessionStore } from "../src/context/session-store.ts";

Deno.test("parseSessionFile reads v1 format", () => {
  const json = JSON.stringify({
    version: 1,
    id: "abc",
    savedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
  });
  const messages = parseSessionFile(json, "abc");
  assertEquals(messages.length, 0);
});

Deno.test("parseSessionFile reads legacy messages wrapper", () => {
  const json = JSON.stringify({ messages: [] });
  const messages = parseSessionFile(json);
  assertEquals(messages.length, 0);
});

Deno.test("SessionStore save and load round-trip", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const store = new SessionStore(dir);
    const id = "test-session";
    const messages: ChatMessageData[] = [];
    await store.save(id, messages);
    assertEquals(await store.exists(id), true);
    const loaded = await store.load(id);
    assertEquals(loaded.length, 0);
    assertEquals(await store.list(), [id]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore load throws for missing id", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const store = new SessionStore(dir);
    await assertRejects(() => store.load("missing"), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
