/**
 * openclaw-style turn receipt renderer, shared by the streaming extension
 * and the core goal-progress card. The user contract: after a task finishes,
 * the content returns to the openclaw summary format, including the cache
 * hit rate (命中率) line.
 */
import type { StatusStats } from "../harness/adapters/status.js";
import { renderStatsLine } from "../harness/adapters/status.js";

export interface TokenFold {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TurnReceipt {
  durationMs: number;
  reasoningSteps?: number;
  toolCalls?: number;
  tokens?: TokenFold;
  sessionStats?: StatusStats;
  /** Goal title prefix: `✅ <objective>` instead of the generic header. */
  goalObjective?: string;
  /** openclaw draft edit telemetry (issue #15): Telegram edit hit rate. */
  editAttempts?: number;
  editSucceeded?: number;
}

function formatTokensCompact(tokens: number): string {
  const scaled = (value: number): string => (value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10));
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e6) return `${scaled(tokens / 1e3)}K`;
  return `${scaled(tokens / 1e6)}M`;
}

/** Exact openclaw receipt format: header, activity, tokens + cache hit rate,
 * then performance segments. `goalObjective` makes it a goal completion. */
export function renderTurnReceipt(receipt: TurnReceipt): string {
  const seconds = Math.max(1, Math.round(receipt.durationMs / 1000));
  const title = receipt.goalObjective === undefined
    ? `\u2699\uFE0F \u5B8C\u6210 \u00B7 \u23F1\uFE0F ${seconds}s`
    : `\u2705 ${receipt.goalObjective.slice(0, 60)} \u00B7 \u23F1\uFE0F ${seconds}s`;
  const lines = [title, "\u2500".repeat(9)];

  const activity: string[] = [];
  if ((receipt.reasoningSteps ?? 0) > 0) activity.push(`\u{1F9E0} ${receipt.reasoningSteps} \u6B21\u601D\u8003`);
  if ((receipt.toolCalls ?? 0) > 0) activity.push(`\u{1F6E0}\uFE0F ${receipt.toolCalls} \u6B21\u5DE5\u5177`);
  const statsLine = receipt.sessionStats === undefined ? undefined : renderStatsLine(receipt.sessionStats);
  const statsSegments = statsLine?.split(" | ") ?? [];
  if (statsSegments[0] !== undefined) activity.push(statsSegments[0]);
  if (activity.length > 0) lines.push(activity.join(" \u00B7 "));

  const billed = (receipt.tokens?.uncachedInputTokens ?? 0) + (receipt.tokens?.cacheReadTokens ?? 0) + (receipt.tokens?.cacheWriteTokens ?? 0);
  if (billed > 0 || (receipt.tokens?.outputTokens ?? 0) > 0) {
    const tokens = [
      `\u{1F4E5} \u8F93\u5165 ${formatTokensCompact(billed)} tok`,
      `\u{1F4E4} \u8F93\u51FA ${formatTokensCompact(receipt.tokens?.outputTokens ?? 0)} tok`,
    ];
    if (billed > 0) {
      const hit = Math.round(((receipt.tokens?.cacheReadTokens ?? 0) / billed) * 100);
      tokens.push(`\u{1F4BE} \u547D\u4E2D ${hit}%`);
    }
    lines.push(tokens.join(" \u00B7 "));
  }

  const editAttempts = receipt.editAttempts ?? 0;
  if (editAttempts > 0) {
    const editRate = Math.round(((receipt.editSucceeded ?? 0) / editAttempts) * 100);
    lines.push(`\u{1F3AF} OpenClaw: ${editAttempts} \u6B21 editText \u00B7 \u547D\u4E2D ${editRate}%`);
  }

  const performance = statsSegments.slice(1).filter((segment) => segment !== undefined).join(" \u00B7 ");
  if (performance !== "") lines.push(performance);
  return lines.join("\n");
}
