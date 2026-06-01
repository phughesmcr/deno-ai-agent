import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

import { formatTodoListMarkdown, formatTodoListPlain } from "../../src/telegram/todo-list-format.ts";
import { createNoopTodoDisplayPort } from "../../src/tools/todo-display-port.ts";
import {
  copyTodosForSession,
  createTodoWriteTool,
  detectTodoChanges,
  formatTodoWriteResult,
  readTodoFile,
  readTodosForSession,
  type TodoItem,
  updateTelegramMeta,
  validateTodoWriteParams,
} from "../../src/tools/todo-write.ts";
import { createTestWorkspace, runTool } from "./helpers.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID_2 = "00000000-0000-4000-8000-000000000002";

function sampleTodos(): TodoItem[] {
  return [
    { id: "1", content: "First task", status: "pending" },
    { id: "2", content: "Second task", status: "in_progress" },
  ];
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

Deno.test("todo persistence round-trip via mutation queue", async () => {
  const { dir, cleanup } = await createTestWorkspace();
  const todosDir = `${dir}/todos`;
  await Deno.mkdir(todosDir, { recursive: true });
  try {
    const todos = sampleTodos();
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      todosDir,
      display: createNoopTodoDisplayPort(),
    });
    const result = await runTool(tool, { todos });
    assertStringIncludes(result, "system-reminder");
    assertEquals(await readTodosForSession(todosDir, SESSION_ID), todos);
  } finally {
    await cleanup();
  }
});

Deno.test("formatTodoWriteResult handles empty list", () => {
  const result = formatTodoWriteResult([]);
  assertStringIncludes(result, "cleared");
  assertStringIncludes(result, "empty");
});

Deno.test("createTodoWriteTool succeeds when display throws", async () => {
  const { dir, cleanup } = await createTestWorkspace();
  const todosDir = `${dir}/todos`;
  await Deno.mkdir(todosDir, { recursive: true });
  try {
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      todosDir,
      display: {
        isAvailable: () => true,
        setTurnContext: () => {},
        clearTurnContext: () => {},
        onTodosUpdated: () => Promise.reject(new Error("display failed")),
      },
    });
    const result = await runTool(tool, { todos: sampleTodos() });
    assertStringIncludes(result, "modified successfully");
    assertEquals(await readTodosForSession(todosDir, SESSION_ID), sampleTodos());
  } finally {
    await cleanup();
  }
});

Deno.test("createTodoWriteTool calls display port with changes", async () => {
  const { dir, cleanup } = await createTestWorkspace();
  const todosDir = `${dir}/todos`;
  await Deno.mkdir(todosDir, { recursive: true });
  let called = false;
  try {
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      todosDir,
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
  } finally {
    await cleanup();
  }
});

Deno.test("updateTelegramMeta merges without clobbering todos", async () => {
  const { dir, cleanup } = await createTestWorkspace();
  const todosDir = `${dir}/todos`;
  await Deno.mkdir(todosDir, { recursive: true });
  try {
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      todosDir,
      display: createNoopTodoDisplayPort(),
    });
    await runTool(tool, { todos: sampleTodos() });
    await updateTelegramMeta(todosDir, SESSION_ID, { chatId: 1, threadId: 0, messageId: 99 });
    const file = await readTodoFile(todosDir, SESSION_ID);
    assertEquals(file.todos, sampleTodos());
    assertEquals(file.telegram, { chatId: 1, threadId: 0, messageId: 99 });
  } finally {
    await cleanup();
  }
});

Deno.test("copyTodosForSession copies todos without telegram meta", async () => {
  const { dir, cleanup } = await createTestWorkspace();
  const todosDir = `${dir}/todos`;
  await Deno.mkdir(todosDir, { recursive: true });
  try {
    const tool = createTodoWriteTool({
      getSessionId: () => SESSION_ID,
      todosDir,
      display: createNoopTodoDisplayPort(),
    });
    await runTool(tool, { todos: sampleTodos() });
    await updateTelegramMeta(todosDir, SESSION_ID, { chatId: 1, messageId: 42 });
    await copyTodosForSession(todosDir, SESSION_ID, SESSION_ID_2);
    const copied = await readTodoFile(todosDir, SESSION_ID_2);
    assertEquals(copied.todos, sampleTodos());
    assertEquals(copied.telegram, undefined);
  } finally {
    await cleanup();
  }
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
