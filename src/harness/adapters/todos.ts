/**
 * Todo domain over the durable `todo/write` session event. The schema is
 * minimal (content + status), so priority is derived from common text tags
 * (`[P0]`/`high`/🔴…) for display only — never invented into the model list.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface TodoView {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoDiff {
  added: TodoView[];
  started: TodoView[];
  completed: TodoView[];
  remaining: number;
}

interface EventLike {
  type?: string;
  data?: { todos?: readonly TodoView[] };
}

/** Latest whole-list snapshot for one live agent (last write wins). */
export function listTodos(ctx: Context, agentId: string): TodoView[] {
  const agent = ctx.agents?.get(agentId as never) as unknown as
    | { session?: { events?: readonly EventLike[] } }
    | undefined;
  const events = agent?.session?.events;
  if (!events) return [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "todo/write" && Array.isArray(event.data?.todos)) {
      return event.data.todos.map((todo) => ({
        content: typeof todo.content === "string" ? todo.content : String(todo.content ?? ""),
        status: todo.status === "completed" || todo.status === "in_progress" ? todo.status : "pending",
      }));
    }
  }
  return [];
}

/** Incomplete tasks only — the bar counter measures remaining work. */
export function pendingTodoCount(todos: readonly TodoView[]): number {
  return todos.filter((todo) => todo.status !== "completed").length;
}

/** Compact diff for the notification card (stable order, statuses only). */
export function diffTodos(previous: readonly TodoView[], next: readonly TodoView[]): TodoDiff {
  const previousByContent = new Map(previous.map((todo) => [todo.content, todo] as const));
  const added = next.filter((todo) => !previousByContent.has(todo.content));
  const started = next.filter((todo) => todo.status === "in_progress" && previousByContent.get(todo.content)?.status === "pending");
  const completed = next.filter((todo) => todo.status === "completed" && previousByContent.get(todo.content)?.status !== "completed");
  return {
    added,
    started,
    completed,
    remaining: pendingTodoCount(next),
  };
}

const PRIORITY_HIGH = /(?:^|[^A-Za-z0-9])(?:🔴|P0|high|urgent|紧急|高)(?:[^A-Za-z0-9]|$)/i;
const PRIORITY_MEDIUM = /(?:^|[^A-Za-z0-9])(?:🟡|P1|medium|中)(?:[^A-Za-z0-9]|$)/i;

/** Display priority tag; absent from the durable schema, so this only colors
 * the Telegram card and never mutates the todo list. */
export function todoPriority(content: string): "high" | "medium" | "low" {
  if (PRIORITY_HIGH.test(content)) return "high";
  if (PRIORITY_MEDIUM.test(content)) return "medium";
  return "low";
}

export function todoIcon(todo: TodoView): string {
  if (todo.status === "completed") return "\u2705";
  if (todo.status === "in_progress") return "\u23F3";
  return todoPriority(todo.content) === "high" ? "\u{1F534}" : todoPriority(todo.content) === "medium" ? "\u{1F7E1}" : "\u{1F7E2}";
}

/** One-line card renderer shared by /todo and the todo card. */
export function renderTodos(todos: readonly TodoView[]): string {
  if (todos.length === 0) return "(no todos yet)";
  return todos
    .map((todo) => {
      const tag = todo.status === "completed" ? "[completed]" : todo.status === "in_progress" ? "[in_progress]" : "[pending]";
      const priority = todo.status === "completed" ? "" : ` \u00B7 ${todoPriority(todo.content)}`;
      return `${todoIcon(todo)} ${todo.content} \u00B7 ${tag}${priority}`;
    })
    .join("\n");
}
