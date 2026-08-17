/**
 * dsh-openclaw: openclaw-style streaming progress draft, as a decoupled
 * plugin. Subscribes to the core bridge's official `session/event` feed and
 * owns one draft message per turn — the core knows nothing about streaming
 * rendering. Hot-pluggable via the loader (telegram-openclaw entry).
 *
 * Format mirrors openclaw's Telegram progress draft (research notes 03/06/
 * 08/19/26):
 * - header line while working: `⚙ Working…`
 * - thinking bursts flow in place as one `🧠 <i>…</i>` line; a tool line
 *   commits (freezes) the current burst and the next burst starts a new line
 * - tool lines: `<b>{emoji|✓|✗} name</b> <code>detail</code>
 *   <i>running|failed</i>`, keyed merge by callId; the icon swaps to
 *   ✓/✗ once the result lands
 * - on turn end the draft collapses into the compact receipt
 *   `🧠 N thoughts · 🛠️ N tool calls · ⏱️ Ns` (openclaw
 *   progress-receipt-tracker) — the final answer itself is delivered as a
 *   separate clean message by the bridge.
 */
import type { Context } from "@deepseek-ai/cordis";
import { escapeHtml } from "../telegram/html.js";
import { markdownToHtml } from "../telegram/markdown.js";
import { renderStatsLine, type StatusStats } from "../harness/adapters/status.js";
import type { ExtensionHost } from "./types.js";

const MAX_LINES = 8;
/** openclaw progress.maxLineChars default for the flowing thinking line. */
const REASONING_MAX_CHARS = 120;
const REASONING_KEEP_CHARS = 600;
const TOOL_DETAIL_CHARS = 90;
const EDIT_THROTTLE_MS = 120;
const NO_REPLY_REMINDER = "\u231B The turn ended without a telegram_reply \u2014 use the telegram_reply tool or reply yourself.";
/** openclaw progress-draft-status-text: strip <think>-style tags. */
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;
const THINKING_HEADER_RE =
  /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i;
/** openclaw tool-display-config subset + dsh telegram tool names. */
const TOOL_EMOJI: Record<string, string> = {
  bash: "\u{1F6E0}\uFE0F",
  exec: "\u{1F6E0}\uFE0F",
  shell: "\u{1F6E0}\uFE0F",
  terminal: "\u{1F6E0}\uFE0F",
  web_search: "\u{1F50E}",
  "web-search": "\u{1F50E}",
  grep_search: "\u{1F50E}",
  "grep-search": "\u{1F50E}",
  search: "\u{1F50E}",
  read: "\u{1F4C4}",
  write: "\u270F\uFE0F",
  apply_patch: "\u270F\uFE0F",
  "apply-patch": "\u270F\uFE0F",
  edit: "\u270F\uFE0F",
  todo: "\u{1F4CB}",
  list: "\u{1F4CB}",
  ls: "\u{1F4CB}",
  glob: "\u{1F4CB}",
  copy: "\u{1F4CB}",
  memory: "\u{1F9E0}",
  recall: "\u{1F9E0}",
  think: "\u{1F9E0}",
  reason: "\u{1F9E0}",
  send_message: "\u{1F4E8}",
  "send-message": "\u{1F4E8}",
  notify: "\u{1F514}",
  http: "\u{1F310}",
  fetch: "\u{1F310}",
  curl: "\u{1F310}",
  browser: "\u{1F310}",
  request: "\u{1F310}",
  docker: "\u{1F433}",
  docker_exec: "\u{1F433}",
  container: "\u{1F433}",
  git: "\u{1F33F}",
  npm: "\u{1F4E6}",
  pnpm: "\u{1F4E6}",
  yarn: "\u{1F4E6}",
  move: "\u{1F4E6}",
  python: "\u{1F40D}",
  node: "\u{1F7E2}",
  tsx: "\u{1F7E2}",
  go: "\u{1F438}",
  rust: "\u{1F980}",
  cargo: "\u{1F980}",
  approve: "\u2705",
  deny: "\u26D4",
  plan: "\u{1F5FA}\uFE0F",
  wait: "\u23F3",
  image: "\u{1F5BC}\uFE0F",
  video: "\u{1F3AC}",
  audio: "\u{1F3B5}",
  tts: "\u{1F50A}",
  voice: "\u{1F399}\uFE0F",
  transcribe: "\u{1F4DD}",
  translate: "\u{1F30D}",
  code: "\u{1F4BB}",
  open: "\u{1F517}",
  close: "\u{1F512}",
  delete: "\u{1F5D1}\uFE0F",
  remove: "\u{1F5D1}\uFE0F",
  rename: "\u{1F3F7}\uFE0F",
  mkdir: "\u{1F4C1}",
  make_dir: "\u{1F4C1}",
  upload: "\u2B06\uFE0F",
  download: "\u2B07\uFE0F",
  export: "\u{1F4E4}",
  import: "\u{1F4E5}",
  telegram_reply: "\u{1F4E8}",
  telegram_send: "\u{1F4E8}",
  telegram_broadcast: "\u{1F4E2}",
  telegram_status: "\u{1F4CA}",
  telegram_ask: "\u2753",
  session_model: "\u{1F9E9}",
  session_snapshot: "\u{1F4F7}",
  workspace: "\u{1F4C2}",
  goal: "\u{1F3AF}",
  subagent: "\u{1F916}",
  skill: "\u{1F9EA}",
};

interface DraftLine {
  key?: string;
  kind: "reasoning" | "tool";
  html: string;
  name?: string;
  detail?: string;
  done?: boolean;
}

interface Draft {
  messageId?: number;
  lines: DraftLine[];
  reasoningRaw: string;
  reasoningLineIndex?: number;
  reasoningSteps: number;
  toolCalls: number;
  startedAt: number;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
  sending?: Promise<number | undefined>;
  /** Per-turn token meter folds (same vocabulary as the web status strip). */
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function toolEmoji(name: string): string {
  const key = name.toLowerCase();
  return TOOL_EMOJI[key] ?? "\u{1F9E9}";
}

/** Tool detail: bash shows the command, telegram_* shows the message body,
 * plain JSON blobs collapse to nothing. */
function toolDetail(name: string, raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  let detail = typeof raw === "string" ? raw.trim() : JSON.stringify(raw);
  if (name === "telegram_reply" || name === "telegram_send" || name === "telegram_broadcast") {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
        detail = ((parsed as { text: string }).text).trim();
      }
    } catch {
      // Not JSON — keep the raw payload.
    }
  }
  if (detail === "{}" || detail === "null" || detail === "") return "";
  const chars = Array.from(detail);
  if (chars.length <= TOOL_DETAIL_CHARS) return detail;
  return `${chars.slice(0, TOOL_DETAIL_CHARS).join("")}\u2026`;
}

function toolLineHtml(name: string, detailRaw: unknown, done: boolean | undefined): string {
  const detail = toolDetail(name, detailRaw);
  const icon = done === true ? "\u2713" : done === false ? "\u2717" : toolEmoji(name);
  const parts: string[] = [`<b>${icon} ${escapeHtml(name)}</b>`];
  if (detail !== "") parts.push(`<code>${escapeHtml(detail)}</code>`);
  if (done === undefined) parts.push("<i>running</i>");
  else if (done === false) parts.push("<i>failed</i>");
  return parts.join(" ");
}

/** openclaw stripThinkingMarkdown: thinking lines stay plain italic text
 * without markdown noise. */
function stripThinkingMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/^>\s+/gm, "");
}

/** openclaw normalizeReasoningProgressLine: strip think tags/headers, fold
 * whitespace into a single line, drop markdown. */
function normalizeReasoning(text: string): string {
  const stripped = (text ?? "").replace(THINKING_TAG_RE, "");
  return stripThinkingMarkdown(stripped)
    .replace(THINKING_HEADER_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** openclaw mergeReasoningProgressText: snapshot replaces the buffer, plain
 * delta appends. */
function mergeReasoning(current: string, incoming: string): string {
  if (current === "") return incoming;
  const normalizedCurrent = normalizeReasoning(current);
  const normalizedIncoming = normalizeReasoning(incoming);
  if (normalizedIncoming === "" || normalizedIncoming === normalizedCurrent) return current;
  const isSnapshot =
    THINKING_HEADER_RE.test(incoming.trimStart()) ||
    (normalizedCurrent !== "" && normalizedIncoming.startsWith(normalizedCurrent));
  return isSnapshot ? incoming : `${current}${incoming}`;
}

function reasoningLineHtml(raw: string): string {
  const normalized = normalizeReasoning(raw);
  if (normalized === "") return "";
  const chars = Array.from(normalized);
  let body = normalized;
  if (chars.length > REASONING_MAX_CHARS) {
    const head = chars.slice(0, Math.max(1, REASONING_MAX_CHARS - 2)).join("").trimEnd();
    const boundary = head.search(/\s+\S*$/u);
    body =
      boundary > Math.floor(REASONING_MAX_CHARS * 0.6)
        ? `${head.slice(0, boundary).trimEnd()}\u2026`
        : `${head}\u2026`;
  }
  return `\u{1F9E0} <i>${escapeHtml(body)}</i>`;
}

function commitReasoning(draft: Draft): void {
  if (draft.reasoningRaw.trim() === "") {
    draft.reasoningRaw = "";
    return;
  }
  if (draft.reasoningLineIndex === undefined) {
    draft.lines.push({ kind: "reasoning", html: reasoningLineHtml(draft.reasoningRaw) });
    draft.reasoningLineIndex = draft.lines.length - 1;
  }
  draft.reasoningSteps += 1;
  draft.reasoningRaw = "";
  draft.reasoningLineIndex = undefined;
}

function trimLines(draft: Draft): void {
  if (draft.lines.length <= MAX_LINES * 2) return;
  const cut = draft.lines.length - MAX_LINES * 2;
  draft.lines.splice(0, cut);
  if (draft.reasoningLineIndex !== undefined) {
    draft.reasoningLineIndex -= cut;
    if (draft.reasoningLineIndex < 0) draft.reasoningLineIndex = undefined;
  }
}

function render(draft: Draft, title: string): string {
  const lines: string[] = [title];
  for (const line of draft.lines.slice(-MAX_LINES)) lines.push(line.html);
  return lines.join("\n");
}

function formatTokensCompact(tokens: number): string {
  const scaled = (value: number): string => (value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10));
  if (tokens < 1e3) return String(tokens);
  if (tokens < 1e6) return `${scaled(tokens / 1e3)}K`;
  return `${scaled(tokens / 1e6)}M`;
}

function buildSummary(draft: Draft, sessionStats?: StatusStats): string {
  const seconds = Math.max(1, Math.round((Date.now() - draft.startedAt) / 1000));
  const lines = [
    `\u2699\uFE0F \u5B8C\u6210 \u00B7 \u23F1\uFE0F ${seconds}s`,
    "\u2500".repeat(9),
  ];

  const activity: string[] = [];
  if (draft.reasoningSteps > 0) activity.push(`\u{1F9E0} ${draft.reasoningSteps} \u6B21\u601D\u8003`);
  if (draft.toolCalls > 0) activity.push(`\u{1F6E0}\uFE0F ${draft.toolCalls} \u6B21\u5DE5\u5177`);

  const statsLine = sessionStats === undefined ? undefined : renderStatsLine(sessionStats);
  const statsSegments = statsLine?.split(" | ") ?? [];
  if (statsSegments[0] !== undefined) activity.push(statsSegments[0]);
  if (activity.length > 0) lines.push(activity.join(" \u00B7 "));

  const billed = draft.uncachedInputTokens + draft.cacheReadTokens + draft.cacheWriteTokens;
  if (billed > 0 || draft.outputTokens > 0) {
    const tokens = [
      `\u{1F4E5} \u8F93\u5165 ${formatTokensCompact(billed)} tok`,
      `\u{1F4E4} \u8F93\u51FA ${formatTokensCompact(draft.outputTokens)} tok`,
    ];
    if (billed > 0) {
      const hit = Math.round((draft.cacheReadTokens / billed) * 100);
      tokens.push(`\u{1F4BE} \u547D\u4E2D ${hit}%`);
    }
    lines.push(tokens.join(" \u00B7 "));
  }

  const performance = statsSegments.slice(1).filter((segment) => segment !== undefined).join(" \u00B7 ");
  if (performance !== "") lines.push(performance);
  return lines.join("\n");
}

interface SessionEventLike {
  type?: string;
  data?: {
    turn?: number;
    usage?: TokenUsageLike;
    chunk?: {
      type?: string;
      blockType?: string;
      index?: number;
      text?: string;
      usage?: TokenUsageLike;
      block?: { type?: string; text?: string };
    };
    name?: string;
    input?: unknown;
    arguments?: unknown;
    callId?: string;
    isError?: boolean;
    message?: {
      source?: { kind?: string; callId?: string };
      content?: readonly { type?: string; isError?: boolean }[];
    };
  };
}

interface TokenUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Cordis dependency: the main dsh-telegram plugin's provided bridge host.
 * The loader waits for this service and hands it over as `ctx.telegram`. */
export const inject = ["telegram"];

export function apply(ctx: Context, _config?: unknown): void {
  const host = ctx.telegram;
  if (host === undefined) return;
  console.error("[dsh-telegram] openclaw streaming feed mounted");
  const chats = new Map<number, Draft>();
  // Latest assistant text block per turn: when this plugin renders the live
  // feed, the core forwards prose here instead of spamming the chat. The
  // plugin owns final delivery at turn/end; the core reminder is suppressed
  // by the consumer registration and replaced here when nothing answered.
  const answers = new Map<number, { text: string; assistantMessageId?: string }>();
  host.setAssistantConsumer((chatId, text, assistantMessageId) => {
    answers.set(chatId, { text, assistantMessageId });
  });
  ctx.effect(() => () => {
    host.setAssistantConsumer(undefined);
    chats.clear();
    answers.clear();
  });

  const flush = (chatId: number, draft: Draft, title: string): void => {
    if (!draft.dirty || draft.messageId === undefined) return;
    draft.dirty = false;
    const text = render(draft, title);
    void host
      .editMessage(chatId, draft.messageId, text, { parse_mode: "HTML" })
      .catch((err) => {
        console.error("[openclaw] edit failed", err);
        draft.messageId = undefined;
      });
  };

  const schedule = (chatId: number, draft: Draft): void => {
    draft.dirty = true;
    if (draft.timer !== undefined) return;
    draft.timer = setTimeout(() => {
      draft.timer = undefined;
      flush(chatId, draft, "\u2699\uFE0F Working\u2026");
    }, EDIT_THROTTLE_MS);
  };

  const ensureMessage = (chatId: number, draft: Draft): void => {
    if (draft.messageId !== undefined || draft.sending !== undefined) return;
    const pending = host.send(chatId, "\u2026", { parse_mode: "HTML" });
    draft.sending = pending;
    void pending
      .then((id) => {
        if (id !== undefined) draft.messageId = id;
      })
      .catch((err) => {
        console.error("[openclaw] send placeholder failed", err);
      })
      .finally(() => {
        draft.sending = undefined;
      });
  };

  // Official harness event stream — the same session/event feed the web UI
  // streams from. Filtered to the bridge-bound agent; the draft targets the
  // bound chat.
  (ctx.on as (name: string, listener: (session: { id: unknown }, event: SessionEventLike) => void) => void)("session/event", (session, event) => {
    // Per-chat routing: resolve the owner chat from the session id instead of
    // trusting the most-recently-touched chat, so two chats can stream at once.
    const chatId = host.chatIdForAgent(String(session.id));
    if (chatId === undefined) return;
    // `outbound.liveFeed=false` disables this renderer dynamically; the core
    // falls back to immediate forwarding while this listener stays mounted,
    // so a later `/config set outbound.liveFeed true` needs no restart.
    if (!host.liveFeedEnabled()) return;
    const type = event.type;
    if (type === "turn/start") {
      // Drop only this chat's stale draft; another chat's live draft stays.
      // A previous draft's throttled edit must not fire into the new turn.
      const previous = chats.get(chatId);
      if (previous?.timer !== undefined) {
        clearTimeout(previous.timer);
        previous.timer = undefined;
        previous.dirty = false;
      }
      chats.delete(chatId);
      answers.delete(chatId);
      chats.set(chatId, {
        lines: [],
        reasoningRaw: "",
        reasoningSteps: 0,
        toolCalls: 0,
        startedAt: Date.now(),
        dirty: false,
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      return;
    }
    // Final delivery must never depend on the live draft: a turn whose
    // turn/start was dropped (or whose draft was never created) still has to
    // deliver its buffered final answer / reminder. Keep this branch above
    // the draft-existence guard.
    if (type === "turn/end") {
      const draft = chats.get(chatId);
      if (draft !== undefined) {
        if (draft.timer !== undefined) {
          clearTimeout(draft.timer);
          draft.timer = undefined;
        }
        commitReasoning(draft);
        const sessionStats = host.statusStats() as StatusStats | undefined;
        const hasContent = draft.reasoningSteps > 0 || draft.toolCalls > 0;
        const finalize = (messageId: number | undefined): void => {
          if (messageId === undefined) return;
          if (hasContent) {
            void host
              .editMessage(chatId, messageId, buildSummary(draft, sessionStats), { parse_mode: "HTML" })
              .catch(() => {});
          } else {
            void host.deleteMessage(chatId, messageId).catch(() => {});
          }
        };
        if (draft.messageId !== undefined) {
          finalize(draft.messageId);
        } else if (draft.sending !== undefined) {
          // The placeholder is still in flight: finalize it when it lands
          // instead of leaving a stray "…" message behind.
          void draft.sending.then(finalize).catch(() => {});
        }
        chats.delete(chatId);
      }

      // Final delivery is this plugin's job while it is mounted: the newest
      // prose block is the turn's answer; without one the openclaw-mode
      // reminder replaces the core's (suppressed) reminder. A tool reply
      // (telegram_reply) already answered the inbound — skip both.
      const answer = answers.get(chatId);
      answers.delete(chatId);
      if (host.pendingInbound(chatId)) {
        const text = answer !== undefined ? markdownToHtml(answer.text) : NO_REPLY_REMINDER;
        const inboundMessageId = host.inboundMessageId(chatId);
        const agentId = host.agentIdForChat(chatId);
        const assistantMessageId = answer?.assistantMessageId;
        void host
          .send(chatId, text, {
            parse_mode: "HTML",
            ...(inboundMessageId === undefined ? {} : { reply_parameters: { message_id: inboundMessageId } }),
          })
          .then((telegramMessageId) => {
            if (telegramMessageId !== undefined && agentId !== undefined && assistantMessageId !== undefined) {
              host.attachFeedback(chatId, telegramMessageId, agentId, assistantMessageId);
            }
            host.markInboundReplied(chatId);
          })
          .catch((err) => {
            console.error("[openclaw] final answer send failed", err);
          });
      }
      return;
    }
    const draft = chats.get(chatId);
    if (!draft) return;

    // Thinking bursts: text/reasoning deltas flow into one 🧠 line, replaced
    // in place on every edit — the openclaw "block that flows" behavior.
    // Complete text blocks are authoritative snapshots: they replace the
    // partial stream of the same block instead of duplicating it.
    if (type === "assistant/chunk") {
      const chunk = event.data?.chunk;
      const usage = chunk?.type === "usage" ? chunk.usage : event.data?.usage;
      if (usage !== undefined) {
        draft.uncachedInputTokens += usage.inputTokens ?? 0;
        draft.outputTokens += usage.outputTokens ?? 0;
        draft.cacheReadTokens += usage.cacheReadTokens ?? 0;
        draft.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
      }
      const deltaText =
        chunk !== undefined && (chunk.type === "text-delta" || chunk.type === "reasoning-delta") && typeof chunk.text === "string" && chunk.text !== ""
          ? chunk.text
          : undefined;
      const blockText =
        chunk !== undefined && chunk.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string"
          ? chunk.block.text
          : undefined;
      if (deltaText !== undefined || blockText !== undefined) {
        draft.reasoningRaw = blockText !== undefined ? blockText : mergeReasoning(draft.reasoningRaw, deltaText as string);
        const chars = Array.from(draft.reasoningRaw);
        if (chars.length > REASONING_KEEP_CHARS) {
          draft.reasoningRaw = chars.slice(0, REASONING_KEEP_CHARS).join("");
        }
        const html = reasoningLineHtml(draft.reasoningRaw);
        if (html !== "") {
          if (draft.reasoningLineIndex === undefined) {
            draft.lines.push({ kind: "reasoning", html });
            draft.reasoningLineIndex = draft.lines.length - 1;
            trimLines(draft);
          } else {
            const line = draft.lines[draft.reasoningLineIndex];
            if (line !== undefined) line.html = html;
          }
          ensureMessage(chatId, draft);
          schedule(chatId, draft);
        }
      }
      return;
    }
    if (type === "tool/call") {
      const data = event.data ?? {};
      const name = typeof data.name === "string" && data.name !== "" ? data.name : "tool";
      const detailRaw = data.arguments !== undefined ? data.arguments : data.input;
      const key = typeof data.callId === "string" ? data.callId : `call:${draft.toolCalls}`;
      // A tool line lands between reasoning bursts: commit the current
      // thinking line so the next thought starts its own line.
      commitReasoning(draft);
      const existing = draft.lines.find((line) => line.kind === "tool" && line.key === key);
      const html = toolLineHtml(name, detailRaw, undefined);
      if (existing !== undefined) {
        existing.html = html;
        existing.name = name;
        existing.detail = typeof detailRaw === "string" ? detailRaw : JSON.stringify(detailRaw ?? "");
        existing.done = undefined;
      } else {
        draft.lines.push({
          kind: "tool",
          key,
          html,
          name,
          detail: typeof detailRaw === "string" ? detailRaw : JSON.stringify(detailRaw ?? ""),
        });
        draft.toolCalls += 1;
      }
      trimLines(draft);
      ensureMessage(chatId, draft);
      schedule(chatId, draft);
      return;
    }
    if (type === "tool/result") {
      const data = event.data ?? {};
      const source = data.message?.source;
      const key = typeof source?.callId === "string" ? source.callId : typeof data.callId === "string" ? data.callId : undefined;
      const resultBlock = data.message?.content?.find((block) => block.type === "tool-result");
      const isError = resultBlock !== undefined ? resultBlock.isError === true : data.isError === true;
      const line = key === undefined ? draft.lines.filter((candidate) => candidate.kind === "tool").at(-1) : draft.lines.find((candidate) => candidate.kind === "tool" && candidate.key === key);
      if (line !== undefined && line.done === undefined) {
        line.done = !isError;
        line.html = toolLineHtml(line.name ?? "tool", line.detail ?? "", line.done);
      }
      schedule(chatId, draft);
      return;
    }
  });
}
