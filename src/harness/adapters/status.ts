import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import { currentSessionModel } from "./sessions.js";

/** Whole-session figures mirrored from the web stats strip sources:
 * `sessionStats` + `tokenUsage` projections, plus a live tool-call counter. */
export interface StatusStats {
  turns: number;
  steps: number;
  toolCalls: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StatusSnapshot {
  agentId?: string;
  status: "idle" | "running" | "none";
  provider?: string;
  model?: string;
  /** Reasoning effort of the live selection (web session.models.current). */
  reasoningEffort?: string;
  /** Agent preset in effect (web resolveSessionPreset: latest
   * agent-preset/selected event, falling back to the session header). */
  preset?: string;
  queue: number;
  sessions: number;
  /** Present when any stats source contributed a number (web profile). */
  stats?: StatusStats;
}

/** Live tool/call counts per session — the web trajectory's call count. */
const toolCallCounts = new Map<string, number>();

/** Increment the bound session's tool-call counter (called from the bridge). */
export function noteToolCall(sessionId: string): void {
  toolCallCounts.set(sessionId, (toolCallCounts.get(sessionId) ?? 0) + 1);
}

/** Drop in-memory stats counters on hot unplug / re-mount. */
export function resetStatusStats(): void {
  toolCallCounts.clear();
}

interface SessionLike {
  id?: unknown;
}

interface ProjectionRegistryLike {
  snapshot(session: unknown): { values?: Record<string, unknown> } | undefined;
}

/** Read the web's projection snapshot for one session, fail-soft when the
 * projection registry is not mounted (headless assemblies). */
function projectionValuesFor(ctx: Context, sessionId: string | undefined): Record<string, unknown> | undefined {
  try {
    const get = (ctx as unknown as { get(key: string): unknown }).get.bind(ctx);
    const registry = get("sessionProjections") as ProjectionRegistryLike | undefined;
    if (!registry) return undefined;
    const sessions = (get("sessions") as { list(): SessionLike[] } | undefined)?.list() ?? [];
    const session = sessionId !== undefined ? sessions.find((entry) => String(entry.id) === sessionId) : sessions[0];
    if (!session) return undefined;
    return registry.snapshot(session)?.values;
  } catch {
    return undefined;
  }
}

/** Prefer the projected value when it is present AND nonzero; otherwise fall
 * back to the live event count (a zeroed projection must not shadow data). */
function pickTokens(projected: number | undefined, eventCount: number | undefined): number {
  if (projected !== undefined && projected > 0) return projected;
  return eventCount ?? 0;
}

/** Exact mirror of the web stats strip formatters (dsh-client-ui-conversation). */
function formatTokensWeb(tokens: number): string {
  const scaled = (v: number) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e6) return `${scaled(tokens / 1e3)}K`;
  return `${scaled(tokens / 1e6)}M`;
}

function formatDurationWeb(ms: number): string {
  const s = ms / 1e3;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

/** Conversation stats, multi-line grouped: turn/step, durations, speeds,
 * cache hit, and tokens. Shared by the status card and the streamed draft
 * finalization. */
export function renderStatsStrip(stats: NonNullable<ReturnType<typeof statusSnapshot>["stats"]>): string | undefined {
  const lines: string[] = [];
  if (stats.steps > 0) {
    lines.push(`\u{1F4CA} ${stats.turns} \u8F6E \u00B7 ${stats.steps} \u6B65`);
    const durations: string[] = [];
    if (stats.llmMs > 0) durations.push(`LLM ${formatDurationWeb(stats.llmMs)}`);
    if (stats.toolMs > 0) durations.push(`\u5DE5\u5177\u8C03\u7528 ${formatDurationWeb(stats.toolMs)}`);
    if (durations.length > 0) lines.push(`\u26A1 ${durations.join(" \u00B7 ")}`);
    const speeds: string[] = [];
    if (stats.ttftSteps > 0) speeds.push(`\u9996 token \u5E73\u5747 ${formatDurationWeb(stats.ttftMs / stats.ttftSteps)}`);
    if (stats.decodeMs > 0) speeds.push(`${formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3))} tok/s`);
    if (speeds.length > 0) lines.push(`\u{1F3AF} ${speeds.join(" \u00B7 ")}`);
  }
  const billed = stats.uncachedInputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
  if (billed > 0 || stats.outputTokens > 0) {
    const hit = billed === 0 ? null : Math.round((stats.cacheReadTokens / billed) * 100);
    if (hit !== null) lines.push(`\u{1F4BE} \u7F13\u5B58\u547D\u4E2D ${hit}%`);
    lines.push(`\u{1F4DD} \u8F93\u5165 ${formatTokensWeb(billed)} tok \u00B7 \u8F93\u51FA ${formatTokensWeb(stats.outputTokens)} tok`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** Per-agent figures counted from the in-memory session event log
 * (turns/steps/tool calls/token usage incl. cache reads). Works in every
 * profile; the projection registry only adds LLM/tool latency figures. */
interface EventLike {
  type?: string;
  data?: {
    usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    chunk?: { type?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } };
  };
}

function eventStatsFor(agent: unknown): StatusStats | undefined {
  const events = (agent as { session?: { events?: readonly EventLike[] } })?.session?.events;
  if (!events) return undefined;
  let turns = 0;
  let steps = 0;
  let toolCalls = 0;
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const event of events) {
    if (event.type === "turn/start") turns += 1;
    else if (event.type === "step/start") steps += 1;
    else if (event.type === "tool/call") toolCalls += 1;
    else if (event.type === "assistant/chunk") {
      const usage = event.data?.chunk?.type === "usage" ? event.data.chunk.usage : event.data?.usage;
      if (usage !== undefined) {
        uncachedInputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        cacheReadTokens += usage.cacheReadTokens ?? 0;
        cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      }
    }
  }
  if (turns === 0 && steps === 0 && toolCalls === 0 && outputTokens === 0 && cacheReadTokens === 0) return undefined;
  return {
    turns,
    steps,
    toolCalls,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function statusSnapshot(ctx: Context, preferAgentId?: string, fallbackToFirst = true): StatusSnapshot {
  const agents = ctx.agents?.list() ?? [];
  // The bridge-bound session drives the bar/status figures; `agents[0]` is
  // only a fallback for profiles/views without a bound chat. Chat-scoped
  // callers pass `fallbackToFirst: false` so an unbound chat shows "none"
  // instead of borrowing another chat's live agent.
  const preferred = preferAgentId !== undefined ? agents.find((entry) => String(entry.id) === preferAgentId) : undefined;
  const agent = preferred ?? (fallbackToFirst ? agents[0] : undefined);
  const sessions = ctx.get("sessions");
  const agentId = agent?.id;
  const values = projectionValuesFor(ctx, agentId === undefined ? undefined : String(agentId));
  const projected = values?.["sessionStats"] as
    | Partial<{ turns: number; steps: number; llmMs: number; toolMs: number; ttftMs: number; ttftSteps: number; decodeMs: number; decodeTokens: number }>
    | undefined;
  const usage = values?.["tokenUsage"] as
    | Partial<{ uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>
    | undefined;
  const toolCalls = agentId === undefined ? 0 : (toolCallCounts.get(String(agentId)) ?? 0);
  const eventStats = agent === undefined ? undefined : eventStatsFor(agent);
  const hasStats = eventStats !== undefined || projected !== undefined || usage !== undefined || toolCalls > 0;
  const selection = agentId === undefined ? {} : currentSessionModel(ctx, String(agentId));
  const session = agent as unknown as { session?: { events?: readonly { type?: string; data?: { agentPreset?: unknown } }[]; header?: { agentPreset?: unknown } } } | undefined;
  const events = session?.session?.events ?? [];
  let preset: string | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "agent-preset/selected") {
      preset = String(event.data?.agentPreset ?? "");
      break;
    }
  }
  if (preset === undefined && session?.session?.header?.agentPreset !== undefined) {
    preset = String(session.session.header.agentPreset);
  }
  return {
    agentId: agent?.id,
    status: agent ? agent.status : "none",
    provider: selection.provider ?? agent?.options.provider,
    model: selection.model ?? agent?.options.model,
    reasoningEffort: selection.reasoningEffort,
    preset,
    queue: agent ? agent.inbox.nextTurn.length + agent.inbox.nextStep.length : 0,
    sessions: sessions ? sessions.list().length : 0,
    ...(!hasStats
      ? {}
      : {
          stats: {
            // A projection that exists but is all zeros must not shadow the
            // live event counts (fresh process: token-meter folds are empty).
            turns: (projected?.turns ?? 0) > 0 ? projected!.turns! : (eventStats?.turns ?? 0),
            steps: (projected?.steps ?? 0) > 0 ? projected!.steps! : (eventStats?.steps ?? 0),
            toolCalls: Math.max(eventStats?.toolCalls ?? 0, toolCalls),
            llmMs: projected?.llmMs ?? 0,
            toolMs: projected?.toolMs ?? 0,
            ttftMs: projected?.ttftMs ?? 0,
            ttftSteps: projected?.ttftSteps ?? 0,
            decodeMs: projected?.decodeMs ?? 0,
            decodeTokens: projected?.decodeTokens ?? 0,
            uncachedInputTokens: pickTokens(usage?.uncachedInputTokens, eventStats?.uncachedInputTokens),
            outputTokens: pickTokens(usage?.outputTokens, eventStats?.outputTokens),
            cacheReadTokens: pickTokens(usage?.cacheReadTokens, eventStats?.cacheReadTokens),
            cacheWriteTokens: pickTokens(usage?.cacheWriteTokens, eventStats?.cacheWriteTokens),
          },
        }),
  };
}
