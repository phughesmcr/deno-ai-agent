import { assertEquals } from "jsr:@std/assert@1/equals";
import type { SavedSessionSummary, SessionManager, SessionStatus } from "../src/agent/context/session.ts";
import { formatSessionStatus, SESSION_HELP, TelegramCommandHandler } from "../src/telegram/commands.ts";

class FakeSession {
  id = "current";
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
  statusValue: SessionStatus = {
    id: "current",
    name: "active",
    dirty: false,
    existsOnDisk: true,
    messageCount: 3,
    tokenCount: 25,
    maxContextLength: 100,
  };

  status(): SessionStatus {
    return { ...this.statusValue, id: this.id };
  }

  refreshStatus(): Promise<SessionStatus> {
    this.refreshCalls++;
    return Promise.resolve({ ...this.status(), tokenCount: 40 });
  }

  newSession(): string {
    this.id = "new-id";
    this.statusValue = { ...this.statusValue, id: "new-id", name: undefined, dirty: false, existsOnDisk: false };
    return this.id;
  }

  save(): Promise<string> {
    return this.saveError ? Promise.reject(this.saveError) : Promise.resolve(this.id);
  }

  load(ref: string): Promise<void> {
    this.loadIds.push(ref);
    if (this.loadError) return Promise.reject(this.loadError);
    this.id = ref === "archived" ? "archived" : this.id;
    this.statusValue = {
      ...this.statusValue,
      id: this.id,
      name: ref === "archived" ? undefined : this.statusValue.name,
      dirty: false,
      existsOnDisk: true,
    };
    return Promise.resolve();
  }

  rename(name: string): Promise<void> {
    this.renameNames.push(name);
    if (this.renameError) return Promise.reject(this.renameError);
    this.statusValue = { ...this.statusValue, name };
    return Promise.resolve();
  }

  fork(): Promise<{ fromId: string; toId: string }> {
    return this.forkError ? Promise.reject(this.forkError) : Promise.resolve({ fromId: "current", toId: "forked" });
  }

  listSaved(): Promise<SavedSessionSummary[]> {
    return Promise.resolve(this.listSavedResult);
  }

  compact(instructions?: string): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    this.compactInstructions.push(instructions);
    if (this.compactError) return Promise.reject(this.compactError);
    return Promise.resolve({ compacted: true, beforeTokens: 90, afterTokens: 30 });
  }
}

function createHandler(session = new FakeSession()): { handler: TelegramCommandHandler; session: FakeSession } {
  return {
    handler: new TelegramCommandHandler(session as unknown as SessionManager),
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
  assertEquals(handler.newSession(), "New session.\nID: new-id\n\nUse /save to persist.");
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
  assertEquals(await handler.fork(), "Forked.\nFrom: current\nTo: forked\n\nUse /save on the new branch when ready.");
  assertEquals(
    await handler.list(),
    "Saved sessions:\narchived (current)\nactive — current",
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
  const { handler } = createHandler(session);

  assertEquals(await handler.save(), "Save failed: disk full");
  assertEquals(await handler.load(), "Usage: /load <id|name>\n\n/list shows saved sessions.");
  assertEquals(await handler.load("bad"), "Load failed: missing");
  assertEquals(await handler.rename(), "Usage: /rename <name>");
  assertEquals(await handler.rename("bad"), "Rename failed: Invalid session name");
  assertEquals(await handler.fork(), "Fork failed: cannot fork");
  assertEquals(await handler.compact(), "Compaction failed: model unavailable");
  assertEquals(await handler.list(), "No saved sessions. /save writes the current chat.");
});
