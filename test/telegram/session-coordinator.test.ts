import { assertEquals } from "jsr:@std/assert@1";

import type {
  AgentSessions,
  SavedSessionSummary,
  SessionCompactionResult,
  SessionStatus,
  SessionTurnOptions,
  SessionTurnResult,
} from "../../src/agent/mod.ts";
import { TelegramSessionBindingStore } from "../../src/telegram/session-binding-store.ts";
import { TelegramSessionCoordinator } from "../../src/telegram/session-coordinator.ts";

class FakeAgentSessions implements AgentSessions {
  current: { id: string; name?: string } = { id: "initial" };
  nextIds = ["created-1", "created-2", "forked-1"];
  savedIds: string[] = [];
  loadedRefs: string[] = [];
  loadError: Error | undefined;

  turn(_input: string, _options: SessionTurnOptions): Promise<SessionTurnResult> {
    return Promise.resolve({
      replyTexts: [],
      turnTokens: 0,
      compacted: false,
      totalTokens: 0,
    });
  }

  new(): SessionStatus {
    this.current = { id: this.nextIds.shift() ?? "created-fallback" };
    return this._status(false);
  }

  save(): Promise<SessionStatus> {
    this.savedIds.push(this.current.id);
    return Promise.resolve(this._status(true));
  }

  load(ref: string): Promise<SessionStatus> {
    this.loadedRefs.push(ref);
    if (this.loadError) return Promise.reject(this.loadError);
    this.current = { id: ref };
    return Promise.resolve(this._status(true));
  }

  fork(): Promise<{ from: SessionStatus; to: SessionStatus }> {
    const from = this._status(true);
    this.current = { id: this.nextIds.shift() ?? "forked-fallback" };
    return Promise.resolve({ from, to: this._status(false) });
  }

  rename(name: string): Promise<SessionStatus> {
    this.current = { ...this.current, name };
    return Promise.resolve(this._status(true));
  }

  list(): Promise<SavedSessionSummary[]> {
    return Promise.resolve([]);
  }

  status(): Promise<SessionStatus> {
    return Promise.resolve(this._status(true));
  }

  compact(): Promise<SessionCompactionResult> {
    return Promise.resolve({ compacted: false, beforeTokens: 0, afterTokens: 0, reason: "manual" });
  }

  applySystemPrompt(): Promise<SessionStatus> {
    return Promise.resolve(this._status(true));
  }

  _status(existsOnDisk: boolean): SessionStatus {
    return {
      id: this.current.id,
      name: this.current.name,
      dirty: false,
      existsOnDisk,
      messageCount: 1,
      tokenCount: 0,
      maxContextLength: 100,
    };
  }
}

async function withCoordinator(
  fn: (
    coordinator: TelegramSessionCoordinator,
    store: TelegramSessionBindingStore,
    sessions: FakeAgentSessions,
  ) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const sessions = new FakeAgentSessions();
  const store = new TelegramSessionBindingStore(kv);
  try {
    await fn(new TelegramSessionCoordinator({ sessions, bindings: store }), store, sessions);
  } finally {
    kv.close();
  }
}

Deno.test("TelegramSessionCoordinator lazily creates, saves, and binds an unbound topic", async () => {
  await withCoordinator(async (coordinator, store, sessions) => {
    const resolution = await coordinator.ensure({ chatId: 1, threadId: 5 }, { createdBy: 99 });

    assertEquals(resolution.created, true);
    assertEquals(resolution.binding.sessionId, "created-1");
    assertEquals(resolution.binding.createdBy, 99);
    assertEquals(sessions.savedIds, ["created-1"]);
    assertEquals((await store.get({ chatId: 1, threadId: 5 }))?.sessionId, "created-1");
  });
});

Deno.test("TelegramSessionCoordinator loads an existing binding before operations", async () => {
  await withCoordinator(async (coordinator, store, sessions) => {
    await store.bind({ chatId: 1, threadId: 5 }, { sessionId: "saved-topic" });

    const status = await coordinator.forConversation({ chatId: 1, threadId: 5 }).status();

    assertEquals(status.id, "saved-topic");
    assertEquals(sessions.loadedRefs, ["saved-topic"]);
  });
});

Deno.test("TelegramSessionCoordinator rebinds /new to a fresh saved session", async () => {
  await withCoordinator(async (coordinator, store, sessions) => {
    await store.bind({ chatId: 1 }, { sessionId: "old" });

    const status = await coordinator.forConversation({ chatId: 1 }).newSession();

    assertEquals(status.id, "created-1");
    assertEquals(sessions.savedIds, ["created-1"]);
    assertEquals((await store.get({ chatId: 1 }))?.sessionId, "created-1");
  });
});

Deno.test("TelegramSessionCoordinator does not rebind when /load fails", async () => {
  await withCoordinator(async (coordinator, store, sessions) => {
    await store.bind({ chatId: 1 }, { sessionId: "old" });
    sessions.loadError = new Error("missing");

    try {
      await coordinator.forConversation({ chatId: 1 }).load("missing");
    } catch {
      // expected
    }

    assertEquals((await store.get({ chatId: 1 }))?.sessionId, "old");
  });
});

Deno.test("TelegramSessionCoordinator saves and rebinds forks", async () => {
  await withCoordinator(async (coordinator, store, sessions) => {
    await store.bind({ chatId: 1, threadId: 5 }, { sessionId: "old" });
    sessions.nextIds = ["forked"];

    const result = await coordinator.forConversation({ chatId: 1, threadId: 5 }).fork();

    assertEquals(result.from.id, "old");
    assertEquals(result.to.id, "forked");
    assertEquals(sessions.loadedRefs, ["old"]);
    assertEquals(sessions.savedIds, ["forked"]);
    assertEquals((await store.get({ chatId: 1, threadId: 5 }))?.sessionId, "forked");
  });
});
