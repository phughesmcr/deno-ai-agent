import { assertEquals } from "jsr:@std/assert@1/equals";
import type { SavedSessionSummary, SessionStatus } from "../src/agent/context/session.ts";
import {
  type CommandCronManager,
  type CommandSession,
  formatSessionStatus,
  SESSION_HELP,
  TelegramCommandHandler,
} from "../src/telegram/commands.ts";

class FakeSession {
  current: { id: string; name?: string } = { id: "current", name: "active" };
  refreshCalls = 0;
  loadIds: string[] = [];
  renameNames: string[] = [];
  renameError: Error | undefined;
  listSavedResult: SavedSessionSummary[] = [
    { id: "archived", createdAt: "2026-06-03T00:00:00.000Z" },
    { id: "current", createdAt: "2026-06-03T00:00:00.000Z", name: "active" },
  ];
  saveError: Error | undefined;
  loadError: Error | undefined;
  forkError: Error | undefined;
  compactError: Error | undefined;
  compactInstructions: (string | undefined)[] = [];
  bindings = [
    {
      chatId: 123,
      sessionId: "main-session",
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
    },
    {
      chatId: 123,
      threadId: 77,
      sessionId: "topic-session",
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
      topicName: "Build",
    },
  ];
  statusValue: SessionStatus = {
    id: "current",
    name: "active",
    dirty: false,
    existsOnDisk: true,
    messageCount: 3,
    tokenCount: 25,
    maxContextLength: 100,
  };

  status(options?: { refresh?: boolean }): Promise<SessionStatus> {
    if (options?.refresh) this.refreshCalls++;
    const tokenCount = options?.refresh ? 40 : this.statusValue.tokenCount;
    return Promise.resolve({ ...this.statusValue, id: this.current.id, name: this.current.name, tokenCount });
  }

  new(): Promise<SessionStatus> {
    this.current = { id: "new-id" };
    this.statusValue = { ...this.statusValue, id: "new-id", name: undefined, dirty: false, existsOnDisk: false };
    return Promise.resolve({ ...this.statusValue });
  }

  newSession(): Promise<SessionStatus> {
    return this.new();
  }

  save(): Promise<SessionStatus> {
    return this.saveError ? Promise.reject(this.saveError) : this.status();
  }

  load(ref: string): Promise<SessionStatus> {
    this.loadIds.push(ref);
    if (this.loadError) return Promise.reject(this.loadError);
    this.current = ref === "archived" ? { id: "archived" } : this.current;
    this.statusValue = {
      ...this.statusValue,
      id: this.current.id,
      name: ref === "archived" ? undefined : this.statusValue.name,
      dirty: false,
      existsOnDisk: true,
    };
    return this.status();
  }

  rename(name: string): Promise<SessionStatus> {
    this.renameNames.push(name);
    if (this.renameError) return Promise.reject(this.renameError);
    this.statusValue = { ...this.statusValue, name };
    this.current = { ...this.current, name };
    return this.status();
  }

  fork(): Promise<{ from: SessionStatus; to: SessionStatus }> {
    return this.forkError ? Promise.reject(this.forkError) : Promise.resolve({
      from: { ...this.statusValue, id: "current" },
      to: { ...this.statusValue, id: "forked", name: undefined },
    });
  }

  list(): Promise<SavedSessionSummary[]> {
    return Promise.resolve(this.listSavedResult);
  }

  compact(
    options?: { instructions?: string },
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    this.compactInstructions.push(options?.instructions);
    if (this.compactError) return Promise.reject(this.compactError);
    return Promise.resolve({ compacted: true, beforeTokens: 90, afterTokens: 30 });
  }

  listBindings(): Promise<typeof this.bindings> {
    return Promise.resolve(this.bindings);
  }
}

class FakeCronManager implements CommandCronManager {
  created: string[] = [];
  deleted: string[] = [];
  listResult = [
    {
      id: "cron-a",
      scheduleText: "Every morning at 8am",
      nextRunAt: "2026-06-06T08:00:00.000Z",
      enabled: true,
      prompt: "Check Gmail.",
      permissionSummary: "mcp:gmail/search",
    },
  ];

  create(input: string): Promise<string> {
    this.created.push(input);
    return Promise.resolve("Created cron job cron-new.\nNext run: 2026-06-06T08:00:00.000Z");
  }

  list(): Promise<typeof this.listResult> {
    return Promise.resolve(this.listResult);
  }

  delete(id: string): Promise<boolean> {
    this.deleted.push(id);
    return Promise.resolve(id === "cron-a");
  }
}

function createHandler(
  cron?: CommandCronManager,
  session = new FakeSession(),
): { handler: TelegramCommandHandler; session: FakeSession } {
  return {
    handler: new TelegramCommandHandler(session as unknown as CommandSession, undefined, cron),
    session,
  };
}

Deno.test("formatSessionStatus renders name, persistence, messages, and token fill", () => {
  assertEquals(
    formatSessionStatus({
      id: "abc",
      name: "demo",
      dirty: true,
      existsOnDisk: true,
      messageCount: 8,
      tokenCount: 33,
      maxContextLength: 100,
    }),
    [
      "Session: demo (abc)",
      "State: saved (unsaved changes)",
      "Messages: 8",
      "Tokens: 33 / 100 (33%)",
    ].join("\n"),
  );
});

Deno.test("TelegramCommandHandler returns text for successful session commands", async () => {
  const { handler, session } = createHandler();

  assertEquals(handler.help(), SESSION_HELP);
  assertEquals(await handler.newSession(), "New session bound to this Telegram conversation.\nID: new-id");
  assertEquals(await handler.save(), "Saved.\nnew-id");
  assertEquals(await handler.compact("keep file paths"), "Compacted.\nTokens before: 90\nTokens after: 30");
  assertEquals(session.compactInstructions, ["keep file paths"]);
  assertEquals(await handler.rename("my-work"), 'Renamed session to "my-work".\nmy-work (new-id)');
  assertEquals(session.renameNames, ["my-work"]);
  assertEquals(
    await handler.load("archived"),
    [
      "Loaded session archived.",
      "",
      "Session: archived",
      "State: saved",
      "Messages: 3",
      "Tokens: 25 / 100 (25%)",
    ].join("\n"),
  );
  assertEquals(session.loadIds, ["archived"]);
  assertEquals(await handler.fork(), "Forked and rebound this Telegram conversation.\nFrom: current\nTo: forked");
  assertEquals(
    await handler.list(),
    "Saved sessions:\narchived (current)\nactive - current",
  );
  assertEquals(
    await handler.topics(),
    "Known topic sessions:\nmain -> main-session\nBuild #77 -> topic-session",
  );
});

Deno.test("TelegramCommandHandler stats refreshes through the session API", async () => {
  const { handler, session } = createHandler();

  assertEquals(
    await handler.stats(),
    [
      "Session: active (current)",
      "State: saved",
      "Messages: 3",
      "Tokens: 40 / 100 (40%)",
    ].join("\n"),
  );
  assertEquals(session.refreshCalls, 1);
});

Deno.test("TelegramCommandHandler returns user-facing command failure text", async () => {
  const session = new FakeSession();
  session.saveError = new Error("disk full");
  session.loadError = new Error("missing");
  session.forkError = new Error("cannot fork");
  session.compactError = new Error("model unavailable");
  session.renameError = new Error("Invalid session name");
  session.listSavedResult = [];
  const { handler } = createHandler(undefined, session);

  assertEquals(await handler.save(), "Save failed: disk full");
  assertEquals(await handler.load(), "Usage: /load <id|name>\n\n/list shows saved sessions.");
  assertEquals(await handler.load("bad"), "Load failed: missing");
  assertEquals(await handler.rename(), "Usage: /rename <name>");
  assertEquals(await handler.rename("bad"), "Rename failed: Invalid session name");
  assertEquals(await handler.fork(), "Fork failed: cannot fork");
  assertEquals(await handler.compact(), "Compaction failed: model unavailable");
  assertEquals(await handler.list(), "No saved sessions. /save writes the current chat.");
});

Deno.test("TelegramCommandHandler returns text for cron commands", async () => {
  const cron = new FakeCronManager();
  const { handler } = createHandler(cron, new FakeSession());

  assertEquals(
    await handler.cron("new Every morning at 8am, Check Gmail."),
    "Created cron job cron-new.\nNext run: 2026-06-06T08:00:00.000Z",
  );
  assertEquals(cron.created, ["Every morning at 8am, Check Gmail."]);
  assertEquals(
    await handler.cron("list"),
    [
      "Cron jobs:",
      "cron-a - Every morning at 8am - next 2026-06-06T08:00:00.000Z",
      "  mcp:gmail/search",
      "  Check Gmail.",
    ].join("\n"),
  );
  assertEquals(await handler.cron("del cron-a"), "Deleted cron job cron-a.");
  assertEquals(await handler.cron("del missing"), "Cron job not found: missing");
});

Deno.test("TelegramCommandHandler returns cron usage without a configured manager", async () => {
  const { handler } = createHandler();

  assertEquals(
    await handler.cron(),
    "Usage: /cron new Every morning at 8am, <prompt>\n/cron list\n/cron del <id>",
  );
});
