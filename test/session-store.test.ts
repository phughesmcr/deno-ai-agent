import { ChatMessage, type ChatMessageData } from "@lmstudio/sdk";
import { assertEquals } from "jsr:@std/assert@1/equals";
import { assertRejects } from "jsr:@std/assert@1/rejects";
import { FORMAT_VERSION, type SessionMessageEntry, SessionStore } from "../src/agent/context/session-store.ts";

type ChatMessageWithRaw = ChatMessage & {
  getRaw(): ChatMessageData;
};

function rawMessage(role: "assistant" | "system" | "user", text: string): ChatMessageData {
  return (ChatMessage.create(role, text) as ChatMessageWithRaw).getRaw();
}

function messageEntry(text: string): SessionMessageEntry {
  return {
    type: "message",
    id: crypto.randomUUID(),
    createdAt: "2026-06-03T00:00:00.000Z",
    message: rawMessage("user", text),
  };
}

Deno.test("SessionStore writes a v2 JSONL header and appends entries", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const store = new SessionStore(dir);
    const id = crypto.randomUUID();
    const first = messageEntry("hello");
    const second = messageEntry("again");

    await store.create(id);
    await store.append(id, first);
    await store.append(id, second);

    assertEquals(await store.exists(id), true);
    const log = await store.read(id);
    assertEquals(log.header.version, FORMAT_VERSION);
    assertEquals(log.header.id, id);
    assertEquals(log.entries, [first, second]);
    assertEquals(await store.list(), [id]);

    const lines = (await Deno.readTextFile(`${dir}/${id}.jsonl`)).trimEnd().split("\n");
    assertEquals(lines.length, 3);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore read throws for missing id", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const store = new SessionStore(dir);
    await assertRejects(() => store.read(crypto.randomUUID()), Deno.errors.NotFound);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore rejects invalid ids for read, exists, create, and append", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const store = new SessionStore(dir);
    const invalidIds = ["../outside", "nested/session", "nested\\session", ".", "..", "test-session"];

    await Promise.all(invalidIds.map(async (id) => {
      await assertRejects(() => store.read(id), Error, "Invalid session id");
      await assertRejects(() => store.exists(id), Error, "Invalid session id");
      await assertRejects(() => store.create(id), Error, "Invalid session id");
      await assertRejects(() => store.append(id, messageEntry("x")), Error, "Invalid session id");
    }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore list ignores legacy JSON and invalid JSONL filenames", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const first = "00000000-0000-4000-8000-000000000001";
    const second = "00000000-0000-4000-8000-000000000002";
    await Deno.writeTextFile(`${dir}/${second}.jsonl`, "{}\n");
    await Deno.writeTextFile(`${dir}/00000000-0000-4000-8000-000000000003.json`, "{}");
    await Deno.writeTextFile(`${dir}/legacy.jsonl`, "{}\n");
    await Deno.writeTextFile(`${dir}/${first}.jsonl`, "{}\n");
    await Deno.writeTextFile(`${dir}/not-json.txt`, "{}");

    const store = new SessionStore(dir);

    assertEquals(await store.list(), [first, second]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore rejects legacy JSON sessions clearly", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(`${dir}/${id}.json`, JSON.stringify({ messages: [rawMessage("user", "old")] }));
    const store = new SessionStore(dir);
    await assertRejects(() => store.read(id), Error, `Legacy session ${id} is not supported`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SessionStore rejects corrupt JSONL lines with a line number", async () => {
  const dir = await Deno.makeTempDir({ prefix: "deno-ai-agent-sessions-" });
  try {
    const id = crypto.randomUUID();
    await Deno.writeTextFile(
      `${dir}/${id}.jsonl`,
      `${JSON.stringify({ version: FORMAT_VERSION, id, createdAt: "2026-06-03T00:00:00.000Z" })}\n{broken\n`,
    );
    const store = new SessionStore(dir);
    await assertRejects(() => store.read(id), Error, "Invalid session JSONL at line 2");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
