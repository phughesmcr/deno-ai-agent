import { escapeMarkdownV2 } from "../markdown.ts";

const TELEGRAM_MAX_LENGTH = 4096;

/** Todo row for Telegram list formatting. */
export type TodoListEntry = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
};

function statusIcon(status: TodoListEntry["status"]): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    default:
      return "[ ]";
  }
}

/** Plain-text todo list for Telegram fallback when MarkdownV2 is rejected. @internal */
export function formatTodoListPlain(todos: TodoListEntry[]): string {
  if (todos.length === 0) return "No active tasks";

  const done = todos.filter((t) => t.status === "completed").length;
  const lines = [`Tasks (${done}/${todos.length} done)`];
  for (const todo of todos) {
    lines.push(`${statusIcon(todo.status)} ${todo.content}`);
  }
  return truncateTodoText(lines.join("\n"));
}

/** MarkdownV2 todo list for Telegram edit/reply. @internal */
export function formatTodoListMarkdown(todos: TodoListEntry[]): string {
  if (todos.length === 0) return escapeMarkdownV2("No active tasks");

  const done = todos.filter((t) => t.status === "completed").length;
  const lines = [escapeMarkdownV2(`Tasks (${done}/${todos.length} done)`)];
  for (const todo of todos) {
    lines.push(`${statusIcon(todo.status)} ${escapeMarkdownV2(todo.content)}`);
  }
  return truncateTodoText(lines.join("\n"));
}

function truncateTodoText(text: string): string {
  if (text.length <= TELEGRAM_MAX_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_MAX_LENGTH - 3)}...`;
}
