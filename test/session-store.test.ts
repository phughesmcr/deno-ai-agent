import { ChatMessage, type ChatMessageData } from "@lmstudio/sdk";
import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import { SessionStore } from "../src/agent/context/session-store.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

Deno.test("SessionStore save and load round-trip", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const store = new SessionStore(dir);
    const id = crypto.randomUUID();
    const messages: ChatMessageData[] = [
      rawMessage("system", "current prompt"),
      rawMessage("user", "hello"),
    ];
    await store.save(id, messages);
    assertEquals(await store.exists(id), true);
    const loaded = await store.load(id);
    assertEquals(loaded, messages);
    assertEquals(await store.list(), [id]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore load throws for missing id", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const store = new SessionStore(dir);
    await assertRejects(() => store.load(crypto.randomUUID()), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore rejects invalid ids for load, exists, and save", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const store = new SessionStore(dir);
    const invalidIds = ["../outside", "nested/session", "nested\\session", ".", "..", "test-session"];

    await Promise.all(invalidIds.map(async (id) => {
      await assertRejects(() => store.load(id), Error, "Invalid session id");
      await assertRejects(() => store.exists(id), Error, "Invalid session id");
      await assertRejects(() => store.save(id, []), Error, "Invalid session id");
    }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore list ignores invalid json filenames", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    await Deno.writeTextFile(`${dir}/${second}.json`, "{}");
    await Deno.writeTextFile(`${dir}/legacy.json`, "{}");
    await Deno.writeTextFile(`${dir}/${first}.json`, "{}");
    await Deno.writeTextFile(`${dir}/not-json.txt`, "{}");

    const store = new SessionStore(dir);

    assertEquals(await store.list(), [first, second]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore rejects legacy array format", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(`${dir}/${id}.json`, JSON.stringify([rawMessage("user", "old")]));
    const store = new SessionStore(dir);
    await assertRejects(() => store.load(id), Error, "Invalid session JSON");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore rejects legacy messages wrapper", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(`${dir}/${id}.json`, JSON.stringify({ messages: [rawMessage("user", "old")] }));
    const store = new SessionStore(dir);
    await assertRejects(() => store.load(id), Error, "Invalid session JSON");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
