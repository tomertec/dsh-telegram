/**
 * Live Todo card renderer (issue #14). The card is opened while the agent is
 * still running and refreshes every few seconds, so the header also encodes
 * the completion state instead of only counts.
 */
import { pendingTodoCount, renderTodos, type TodoView } from "../harness/adapters/todos.js";

/** Todo card renderer shared by the initial open and the periodic refresh. */
export function renderTodosCard(todos: readonly TodoView[], hasLiveAgent: boolean): string {
  const pending = pendingTodoCount(todos);
  const completed = todos.length - pending;
  const header = !hasLiveAgent
    ? "\u{1F4CB} Todos \u00B7 No live agent"
    : pending === 0 && todos.length > 0
      ? `\u2705 Todos complete \u00B7 ${completed}/${todos.length} done`
      : `\u{1F4CB} Todos \u00B7 ${pending} pending \u00B7 ${todos.length} total`;
  const lines = [
    header,
    "",
    ...(todos.length === 0 ? ["(no todos yet)"] : renderTodos(todos).split("\n")),
    "",
    hasLiveAgent
      ? "Auto-refreshes every 5s while this card stays open."
      : "No live agent \u2014 todos are session-scoped.",
  ];
  return lines.join("\n");
}
