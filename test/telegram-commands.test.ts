import { assertEquals } from "jsr:@std/assert@1/equals";
import type { SessionManager, SessionStatus } from "../src/context/session.ts";
import { formatSessionStatus, SESSION_HELP, TelegramCommandHandler } from "../src/telegram/commands.ts";

class FakeSession {
  id = "current";
  refreshCalls = 0;
  loadIds: string[] = [];
  sessions = ["archived", "current"];
  saveError: Error | undefined;
  loadError: Error | undefined;
  forkError: Error | undefined;
  statusValue: SessionStatus = {
    id: "current",
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
    this.statusValue = { ...this.statusValue, dirty: false, existsOnDisk: false };
    return this.id;
  }

  save(): Promise<string> {
    return this.saveError ? Promise.reject(this.saveError) : Promise.resolve(this.id);
  }

  load(id: string): Promise<void> {
    this.loadIds.push(id);
    if (this.loadError) return Promise.reject(this.loadError);
    this.id = id;
    this.statusValue = { ...this.statusValue, dirty: false, existsOnDisk: true };
    return Promise.resolve();
  }

  fork(): Promise<{ fromId: string; toId: string }> {
    return this.forkError ? Promise.reject(this.forkError) : Promise.resolve({ fromId: "current", toId: "forked" });
  }

  list(): Promise<string[]> {
    return Promise.resolve(this.sessions);
  }
}

function createHandler(session = new FakeSession()): { handler: TelegramCommandHandler; session: FakeSession } {
  return {
    handler: new TelegramCommandHandler(session as unknown as SessionManager),
    session,
  };
}

Deno.test("formatSessionStatus renders persistence, messages, and token fill exactly", () => {
  assertEquals(
    formatSessionStatus({
      id: "abc",
      dirty: true,
      existsOnDisk: true,
      messageCount: 8,
      tokenCount: 33,
      maxContextLength: 100,
    }),
    [
      "Session: abc",
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
  assertEquals(await handler.save(), "Saved.\nID: new-id");
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
  assertEquals(await handler.list(), "Saved sessions:\narchived (current)\ncurrent");
});

Deno.test("TelegramCommandHandler stats refreshes through the session API", async () => {
  const { handler, session } = createHandler();

  assertEquals(
    await handler.stats(),
    [
      "Session: current",
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
  session.sessions = [];
  const { handler } = createHandler(session);

  assertEquals(await handler.save(), "Save failed: disk full");
  assertEquals(await handler.load(), "Usage: /load <session-id>\n\n/list shows saved ids.");
  assertEquals(await handler.load("bad"), "Load failed: missing");
  assertEquals(await handler.fork(), "Fork failed: cannot fork");
  assertEquals(await handler.list(), "No saved sessions. /save writes the current chat.");
});
