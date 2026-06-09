import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";

import { createNoopTodoDisplayPort } from "../../src/agent/tools/todo-display-port.ts";
import { DenoKvTodoStore, detectTodoChanges, type TodoItem, type TodoStore } from "../../src/agent/tools/todo-store.ts";
import {
  createTodoWriteTool,
  formatTodoWriteResult,
  validateTodoWriteParams,
} from "../../src/agent/tools/todo-write.ts";
import { formatTodoListMarkdown, formatTodoListPlain } from "../../src/telegram/todo-list-format.ts";
import { runTool } from "./helpers.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID_2 = "00000000-0000-4000-8000-000000000002";

function sampleTodos(): TodoItem[] {
  return [
    { id: "1", content: "First task", status: "pending" },
    { id: "2", content: "Second task", status: "in_progress" },
  ];
}

async function withTodoStore(fn: (store: TodoStore, kv: Deno.Kv) => Promise<void>): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(new DenoKvTodoStore(kv), kv);
  } finally {
    kv.close();
  }
}

Deno.test("validateTodoWriteParams rejects invalid todos", () => {
  assertEquals(
    validateTodoWriteParams({ todos: "nope" as unknown as TodoItem[] }),
    'Parameter "todos" must be an array.',
  );
  assertEquals(
    validateTodoWriteParams({ todos: [{ id: "", content: "x", status: "pending" }] }),
    'Each todo must have a non-empty "id" string.',
  );
  assertEquals(
    validateTodoWriteParams({ todos: [{ id: "a", content: "", status: "pending" }] }),
    'Each todo must have a non-empty "content" string.',
  );
  assertEquals(
    validateTodoWriteParams({ todos: [{ id: "a", content: "x", status: "done" as "pending" }] }),
    'Each todo must have a valid "status" (pending, in_progress, completed).',
  );
  assertEquals(
    validateTodoWriteParams({
      todos: [
        { id: "a", content: "one", status: "pending" },
        { id: "a", content: "two", status: "pending" },
      ],
    }),
    "Todo IDs must be unique within the array.",
  );
  assertEquals(validateTodoWriteParams({ todos: sampleTodos() }), null);
});

Deno.test("detectTodoChanges finds created and completed items", () => {
  const oldTodos: TodoItem[] = [
    { id: "a", content: "Alpha", status: "pending" },
    { id: "b", content: "Beta", status: "in_progress" },
  ];
  const newTodos: TodoItem[] = [
    { id: "a", content: "Alpha", status: "completed" },
    { id: "b", content: "Beta", status: "in_progress" },
    { id: "c", content: "Gamma", status: "pending" },
  ];
  const changes = detectTodoChanges(oldTodos, newTodos);
  assertEquals(changes.completed.map((t) => t.id), ["a"]);
  assertEquals(changes.created.map((t) => t.id), ["c"]);
});

Deno.test("todo persistence round-trip via Deno KV", async () => {
  await withTodoStore(async (store) => {
    const todos = sampleTodos();
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      store,
      display: createNoopTodoDisplayPort(),
    });
    const result = await runTool(tool, { todos });
    assertStringIncludes(result, "system-reminder");
    assertEquals((await store.read(SESSION_ID)).todos, todos);
  });
});

Deno.test("store.read rejects corrupt todo state clearly", async () => {
  await withTodoStore(async (store, kv) => {
    await kv.set(["todos", SESSION_ID], { sessionId: SESSION_ID, todos: "bad" });
    await assertRejects(
      () => store.read(SESSION_ID),
      Error,
      `Invalid todo state for session ${SESSION_ID}`,
    );
  });
});

Deno.test("formatTodoWriteResult handles empty list", () => {
  const result = formatTodoWriteResult([]);
  assertStringIncludes(result, "cleared");
  assertStringIncludes(result, "empty");
});

Deno.test("createTodoWriteTool succeeds when display throws", async () => {
  await withTodoStore(async (store) => {
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      store,
      display: {
        isAvailable: () => true,
        setTurnContext: () => {},
        clearTurnContext: () => {},
        onTodosUpdated: () => Promise.reject(new Error("display failed")),
      },
    });
    const result = await runTool(tool, { todos: sampleTodos() });
    assertStringIncludes(result, "modified successfully");
    assertEquals((await store.read(SESSION_ID)).todos, sampleTodos());
  });
});

Deno.test("createTodoWriteTool calls display port with changes", async () => {
  let called = false;
  await withTodoStore(async (store) => {
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      store,
      display: {
        isAvailable: () => true,
        setTurnContext: () => {},
        clearTurnContext: () => {},
        onTodosUpdated: (payload) => {
          called = true;
          assertEquals(payload.changes.created.length, 2);
          return Promise.resolve();
        },
      },
    });
    await runTool(tool, { todos: sampleTodos() });
    assertEquals(called, true);
  });
});

Deno.test("updateTelegramMeta merges without clobbering todos", async () => {
  await withTodoStore(async (store) => {
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      store,
      display: createNoopTodoDisplayPort(),
    });
    await runTool(tool, { todos: sampleTodos() });
    await store.updateTelegramMeta(SESSION_ID, { chatId: 1, threadId: 0, messageId: 99 });
    const file = await store.read(SESSION_ID);
    assertEquals(file.todos, sampleTodos());
    assertEquals(file.telegram, { chatId: 1, threadId: 0, messageId: 99 });
  });
});

Deno.test("createTodoWriteTool preserves concurrent telegram metadata updates", async () => {
  await withTodoStore(async (store) => {
    await store.updateTelegramMeta(SESSION_ID, { chatId: 1, messageId: 1 });
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      store,
      display: createNoopTodoDisplayPort(),
    });

    await Promise.all([
      runTool(tool, { todos: sampleTodos() }),
      store.updateTelegramMeta(SESSION_ID, { chatId: 2, messageId: 2 }),
    ]);

    const file = await store.read(SESSION_ID);
    assertEquals(file.todos, sampleTodos());
    assertEquals(file.telegram?.chatId, 2);
    assertEquals(file.telegram?.messageId, 2);
  });
});

Deno.test("store.copy copies todos without telegram meta", async () => {
  await withTodoStore(async (store) => {
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      store,
      display: createNoopTodoDisplayPort(),
    });
    await runTool(tool, { todos: sampleTodos() });
    await store.updateTelegramMeta(SESSION_ID, { chatId: 1, messageId: 42 });
    await store.copy(SESSION_ID, SESSION_ID_2);
    const copied = await store.read(SESSION_ID_2);
    assertEquals(copied.todos, sampleTodos());
    assertEquals(copied.telegram, undefined);
  });
});

Deno.test("store.copy is a no-op when the source is missing", async () => {
  await withTodoStore(async (store) => {
    await store.copy(SESSION_ID, SESSION_ID_2);
    assertEquals(await store.read(SESSION_ID_2), { sessionId: SESSION_ID_2, todos: [] });
  });
});

Deno.test("formatTodoListMarkdown escapes and handles empty state", () => {
  assertEquals(formatTodoListPlain([]), "No active tasks");
  assertStringIncludes(formatTodoListMarkdown([]), "No active tasks");
  const markdown = formatTodoListMarkdown([
    { id: "1", content: "Fix (urgent) bug", status: "completed" },
  ]);
  assertStringIncludes(markdown, "Tasks \\(1/1 done\\)");
  assertStringIncludes(markdown, "Fix \\(urgent\\) bug");
});
