/**
 * Session lifecycle and session-domain operations, mirroring the web
 * ApiProxy `sessions` domain (session.list/search/create/history/models/
 * selectModel/rename/fork/prompt/attachment/updateQueue/cancel) over the
 * host seams: ctx.sessions, ctx.agents, ctx.llm, ctx.sessionTitle,
 * ctx.attachments, ctx.agentDefaultModel.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { installModelSelection, type ModelSelectionRef, type AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage, MessageId } from "@deepseek-ai/dsh-llm";
import { SessionId, type Session as DshSession } from "@deepseek-ai/dsh-session";
import { fail, ok, type AdapterResult } from "./types.js";

export interface SessionEntry {
  id: string;
  cwd?: string;
}

/** One event as read from a live or persisted session log (structural). */
export interface SessionEventLike {
  seq: number;
  type: string;
  at?: number;
  data?: Record<string, unknown>;
}

interface SessionLike {
  id: SessionId;
  events: readonly SessionEventLike[];
  header?: { cwd?: string };
}

interface SessionTitleServiceLike {
  get(session: SessionLike): { title: string; eventSeq: number } | undefined;
  rename(session: SessionLike, title: string): { title: string; eventSeq: number };
}

interface AttachmentRefLike {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<AttachmentRefLike>;
  readImage(ref: AttachmentRefLike): Promise<{ ref: AttachmentRefLike; data: Uint8Array }>;
}

interface AgentDefaultModelLike {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string };
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void>;
}

interface PersistenceHeaderLike {
  id: SessionId;
}

interface PersistenceLike {
  list(signal?: AbortSignal): Promise<PersistenceHeaderLike[]>;
  readRaw(id: SessionId, signal?: AbortSignal): Promise<{ events?: readonly SessionEventLike[] } | undefined>;
}

interface AgentLike {
  id: SessionId;
  session: SessionLike;
  options?: { provider?: string; model?: string };
}

function agentsOf(ctx: Context) {
  return (ctx.agents ?? undefined) as
    | {
        list(): AgentLike[];
        get(id: SessionId): AgentLike | undefined;
        create(options: {
          sessionId: SessionId;
          meta?: { cwd?: string };
          agentOptions?: { provider?: string; model?: string };
        }): Promise<AgentHandle>;
        resume(options: { resumeSessionId: SessionId; agentOptions?: { provider?: string; model?: string } }): Promise<AgentHandle>;
      }
    | undefined;
}

function sessionTitleService(ctx: Context): SessionTitleServiceLike | undefined {
  return ctx.get("sessionTitle") as SessionTitleServiceLike | undefined;
}

function attachmentsOf(ctx: Context): AttachmentStoreLike | undefined {
  return ctx.get("attachments") as AttachmentStoreLike | undefined;
}

function defaultModelOf(ctx: Context): AgentDefaultModelLike | undefined {
  return ctx.get("agentDefaultModel") as AgentDefaultModelLike | undefined;
}

function persistenceOf(ctx: Context): PersistenceLike | undefined {
  return ctx.get("sessionPersistence") as PersistenceLike | undefined;
}

function sessionsOf(ctx: Context) {
  return ctx.get("sessions") as
    | {
        list(): SessionLike[];
        get(id: SessionId): SessionLike | undefined;
        fork(id: SessionId, boundary: number | undefined, childId: SessionId): SessionLike;
      }
    | undefined;
}

export function listSessions(ctx: Context): SessionEntry[] {
  const store = sessionsOf(ctx);
  if (!store) return [];
  return store.list().map((s) => ({ id: s.id, cwd: s.header?.cwd }));
}

export interface SessionDetail {
  id: string;
  cwd?: string;
  live: boolean;
  running: boolean;
  title?: string;
  blank: boolean;
  lastPromptAt?: number;
  eventCount: number;
  archived: boolean;
}

function liveSessions(ctx: Context): Map<string, SessionLike> {
  const map = new Map<string, SessionLike>();
  const store = sessionsOf(ctx);
  if (!store) return map;
  for (const session of store.list()) map.set(session.id, session as unknown as SessionLike);
  return map;
}

function sessionById(ctx: Context, id: string): SessionLike | undefined {
  const session = sessionsOf(ctx)?.get(SessionId(id));
  return session as unknown as SessionLike | undefined;
}

function titleFor(ctx: Context, session: SessionLike): string | undefined {
  const titles = sessionTitleService(ctx);
  try {
    const snapshot = titles?.get(session);
    if (snapshot?.title) return snapshot.title;
  } catch {
    /* title service may not own this session */
  }
  for (const event of session.events) {
    if (event.type !== "user/message") continue;
    const content = (event.data as { content?: { type?: string; text?: string }[] } | undefined)?.content;
    const text = content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join(" ");
    if (text && text.trim()) return text.trim().slice(0, 60);
    break;
  }
  return undefined;
}

function scanMeta(session: SessionLike): { blank: boolean; lastPromptAt?: number; eventCount: number } {
  let blank = true;
  let lastPromptAt: number | undefined;
  for (const event of session.events) {
    if (event.type === "turn/start") blank = false;
    if (event.type === "user/message") {
      blank = false;
      lastPromptAt = (event.at ?? event.data?.createdAt) as number | undefined;
    }
  }
  return { blank, lastPromptAt, eventCount: session.events.length };
}

/** session.list: live + persisted sessions with web-style summary metadata. */
export async function listSessionDetails(ctx: Context): Promise<SessionDetail[]> {
  const live = liveSessions(ctx);
  const archived = new Set(archivedSessionIds(ctx));
  const entries = new Map<string, SessionDetail>();
  for (const [id, session] of live) {
    const meta = scanMeta(session);
    entries.set(id, {
      id,
      cwd: session.header?.cwd,
      live: true,
      running: agentsOf(ctx)?.get(SessionId(id)) !== undefined,
      title: titleFor(ctx, session),
      blank: meta.blank,
      lastPromptAt: meta.lastPromptAt,
      eventCount: meta.eventCount,
      archived: archived.has(id),
    });
  }
  const persistence = persistenceOf(ctx);
  if (persistence) {
    try {
      for (const header of await persistence.list()) {
        const id = String(header.id);
        if (entries.has(id)) continue;
        let session: SessionLike | undefined;
        try {
          const raw = await persistence.readRaw(header.id);
          session = raw ? ({ id: header.id, events: raw.events ?? [] } as SessionLike) : undefined;
        } catch {
          /* a broken cold log must not hide the rest of the roster */
        }
        if (!session) continue;
        const meta = scanMeta(session);
        entries.set(id, {
          id,
          live: false,
          running: false,
          title: titleFor(ctx, session),
          blank: meta.blank,
          lastPromptAt: meta.lastPromptAt,
          eventCount: meta.eventCount,
          archived: archived.has(id),
        });
      }
    } catch {
      /* persistence listing failure degrades to the live roster */
    }
  }
  return [...entries.values()];
}

function archivedSessionIds(ctx: Context): string[] {
  const registry = ctx.get("workspaceRegistry") as { archivedSessionIds?: readonly string[] } | undefined;
  return [...(registry?.archivedSessionIds ?? [])].map(String);
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type?: string; text?: string } => typeof block === "object" && block !== null && (block as { type?: string }).type === "text")
    .map((block) => block.text ?? "")
    .join(" ")
    .trim();
}

function snippetOf(event: SessionEventLike): string | undefined {
  if (event.type === "user/message" || event.type === "assistant/message") {
    const text = textOfContent((event.data as { content?: unknown } | undefined)?.content);
    if (text) return text;
  }
  if (event.type === "tool/result") {
    const text = String((event.data as { output?: unknown } | undefined)?.output ?? "");
    if (text.trim()) return text.trim();
  }
  return undefined;
}

export interface SearchHit {
  sessionId: string;
  seq: number;
  type: string;
  snippet: string;
  live: boolean;
}

/** session.search: scan live logs + persisted logs, web-style snippet cap 240. */
export async function searchSessions(ctx: Context, query: string, limit = 20): Promise<SearchHit[]> {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  const pushHits = (id: string, events: readonly SessionEventLike[], live: boolean) => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const snippet = snippetOf(events[i]);
      if (!snippet || !snippet.toLowerCase().includes(needle)) continue;
      hits.push({ sessionId: id, seq: events[i].seq, type: events[i].type, snippet: snippet.slice(0, 240), live });
      if (hits.length >= limit) return;
    }
  };
  for (const [id, session] of liveSessions(ctx)) pushHits(id, session.events, true);
  if (hits.length >= limit) return hits;
  const persistence = persistenceOf(ctx);
  const live = liveSessions(ctx);
  if (persistence) {
    try {
      for (const header of await persistence.list()) {
        const id = String(header.id);
        if (live.has(id)) continue;
        try {
          const raw = await persistence.readRaw(header.id);
          if (raw) pushHits(id, raw.events ?? [], false);
        } catch {
          /* skip unreadable logs */
        }
        if (hits.length >= limit) break;
      }
    } catch {
      /* degrade to live hits */
    }
  }
  return hits;
}

export interface HistoryItem {
  seq: number;
  type: string;
  role: string;
  text: string;
}

/** session.history: read a window of events from a live or persisted session. */
export async function readHistory(ctx: Context, sessionId: string, limit = 20, beforeSeq?: number): Promise<HistoryItem[]> {
  let events: readonly SessionEventLike[] | undefined;
  let live = true;
  const session = sessionById(ctx, sessionId);
  if (session) {
    events = session.events;
  } else {
    const persistence = persistenceOf(ctx);
    if (!persistence) return [];
    const raw = await persistence.readRaw(SessionId(sessionId)).catch(() => undefined);
    events = raw?.events ?? [];
    live = false;
  }
  void live;
  const end = beforeSeq === undefined ? events.length : events.findIndex((e) => e.seq >= beforeSeq);
  const start = Math.max(0, (end === -1 ? events.length : end) - limit);
  const out: HistoryItem[] = [];
  for (const event of events.slice(start, end === -1 ? undefined : end)) {
    const text = snippetOf(event) ?? "";
    let role = event.type;
    if (event.type === "user/message") role = "user";
    else if (event.type === "assistant/message") role = "assistant";
    else if (event.type === "tool/call") role = "tool-call";
    else if (event.type === "tool/result") role = "tool-result";
    out.push({ seq: event.seq, type: event.type, role, text: text.slice(0, 400) });
  }
  return out;
}

/** session.rename over ctx.sessionTitle (the web's exact seam). */
export function renameSession(ctx: Context, sessionId: string, title: string): AdapterResult {
  const session = sessionById(ctx, sessionId);
  if (!session) return fail(`session ${sessionId} is not live (rename needs a live session)`);
  const titles = sessionTitleService(ctx);
  if (!titles) return fail("this profile mounts no session-title service");
  const trimmed = title.trim();
  if (!trimmed) return fail("title must not be blank");
  try {
    const accepted = titles.rename(session, trimmed);
    return ok(`\u270F Renamed to "${accepted.title}"`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** session.fork over ctx.sessions.fork (web semantics: boundary anchors to turn ends). */
export function forkSession(ctx: Context, sessionId: string, atSeq?: number): AdapterResult & { childId?: string } {
  const store = sessionsOf(ctx);
  if (!store) return fail("sessions service is unavailable in this profile");
  try {
    const source = sessionById(ctx, sessionId);
    if (!source) return fail(`session ${sessionId} not found`);
    const events = source.events;
    const lastSeq = events.length ? events[events.length - 1].seq : -1;
    let boundary: number | undefined;
    if (atSeq !== undefined) {
      const found = events.find((e) => e.type === "turn/end" && e.seq >= atSeq);
      if (found) boundary = found.seq;
      else if (atSeq > lastSeq) boundary = [...events].reverse().find((e) => e.type === "turn/end")?.seq;
      if (boundary === undefined) return fail("fork-unavailable: no turn boundary at that position");
    }
    const child = store.fork(SessionId(sessionId), boundary, SessionId(`telegram-${randomUUID()}`));
    return { ok: true, text: `\u{1F500} Forked to ${child.id}`, childId: child.id };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Resume a persisted session as a live agent (session.open equivalent). */
export async function resumeSession(ctx: Context, sessionId: string): Promise<AdapterResult & { agentId?: string; handle?: AgentHandle }> {
  const agents = agentsOf(ctx);
  if (!agents) return fail("agents service is unavailable in this profile");
  try {
    const previous = agents.list()[0];
    const handle = await agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: previous?.options?.provider, model: previous?.options?.model },
    });
    return { ok: true, text: `\u{1F4C2} Resumed ${handle.agent.id}`, agentId: handle.agent.id, handle };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** session.prompt: route text to queue or steer, mirroring the web modes. */
export function promptSession(ctx: Context, sessionId: string, text: string, mode: "queue" | "steer" | "followup"): AdapterResult {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return fail(`session ${sessionId} has no live agent`);
  const message = createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
  const target = agent as unknown as {
    followup(message: unknown): void;
    send(message: unknown, target: string, wakeup: boolean): void;
    steer(message: unknown): void;
  };
  try {
    if (mode === "steer") target.steer(message);
    else if (mode === "queue") target.send(message, "next-turn", false);
    else target.followup(message);
    return ok(mode === "queue" ? "Queued." : mode === "steer" ? "Steered." : "Delivered.");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const selections = new Map<string, { ref: ModelSelectionRef; dispose: () => void }>();

/** session.selectModel: per-session ModelSelectionRef + default persistence. */
export async function selectSessionModel(
  ctx: Context,
  sessionId: string,
  provider: string,
  model: string,
  reasoningEffort?: string,
): Promise<AdapterResult> {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return fail(`session ${sessionId} has no live agent`);
  const llm = ctx.llm as unknown as
    | {
        resolveCallConfig(config: {
          provider: string;
          model: string;
          reasoningEffort?: string;
        }): Promise<{ provider: string; model: string; reasoningEffort?: string }>;
      }
    | undefined;
  if (!llm) return fail("llm service is unavailable in this profile");
  try {
    const resolved = await llm.resolveCallConfig({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) });
    let entry = selections.get(sessionId);
    if (!entry) {
      const ref: ModelSelectionRef = { current: undefined, assembled: undefined };
      const dispose = installModelSelection((agent as unknown as { ctx: Context }).ctx, ref);
      entry = { ref, dispose };
      selections.set(sessionId, entry);
    }
    entry.ref.current = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort as never }),
    };
    const defaults = defaultModelOf(ctx);
    try {
      await defaults?.saveSelection({
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      });
    } catch {
      /* the switch applies to this session even when the default is not saved */
    }
    return ok(`\u{1F4CE} Model switched to ${resolved.provider}/${resolved.model}`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** session.models.current: the per-session selection or the live agent default. */
export function currentSessionModel(ctx: Context, sessionId: string): { provider?: string; model?: string; reasoningEffort?: string } {
  const entry = selections.get(sessionId);
  if (entry?.ref.current) return entry.ref.current as { provider?: string; model?: string; reasoningEffort?: string };
  const agent = agentsOf(ctx)?.get(SessionId(sessionId));
  if (!agent) return {};
  return { provider: agent.options?.provider, model: agent.options?.model };
}

export interface QueueItem {
  itemId: string;
  target: "next-turn" | "next-step";
  text: string;
}

/** session/queue snapshot (the web's events.mux `session/queue` frame). */
export function listQueue(ctx: Context, sessionId: string): QueueItem[] {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return [];
  const inbox = (agent as unknown as { inbox: { nextTurn: { id: string; content: unknown }[]; nextStep: { id: string; content: unknown }[] } }).inbox;
  const out: QueueItem[] = [];
  for (const message of inbox.nextTurn) out.push({ itemId: message.id, target: "next-turn", text: textOfContent(message.content) });
  for (const message of inbox.nextStep) out.push({ itemId: message.id, target: "next-step", text: textOfContent(message.content) });
  return out;
}

export type QueueAction = { kind: "edit"; content: string } | { kind: "remove" } | { kind: "steer" };

/** session.updateQueue over agent.inbox (exact web semantics). */
export function updateQueueItem(ctx: Context, sessionId: string, itemId: string, action: QueueAction): AdapterResult {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return fail("queue-item-not-found: no live agent");
  const inbox = (agent as unknown as {
    inbox: {
      nextTurn: { id: string; content: unknown }[];
      nextStep: { id: string; content: unknown }[];
      replace(id: string, message: unknown): boolean;
      remove(id: string): boolean;
    };
  }).inbox;
  const target = inbox.nextTurn.some((m) => m.id === itemId) ? "next-turn" : inbox.nextStep.some((m) => m.id === itemId) ? "next-step" : undefined;
  if (target === undefined) return fail("queue-item-not-found: item is no longer pending");
  const message = target === "next-turn" ? inbox.nextTurn.find((m) => m.id === itemId) : inbox.nextStep.find((m) => m.id === itemId);
  if (!message) return fail("queue-item-not-found: item is no longer pending");
  if (action.kind === "steer") {
    const status = (agent as unknown as { status: string }).status;
    if (target !== "next-turn" || status !== "running") return fail("steer-unavailable: current turn no longer accepts steering");
  }
  if (action.kind === "edit") {
    inbox.replace(itemId, { ...message, content: [{ type: "text", text: action.content }] });
  } else {
    inbox.remove(itemId);
    if (action.kind === "steer") (agent as unknown as { steer(message: unknown): void }).steer(message);
  }
  return ok("Queue updated.");
}

/** session.attachment admission: promote image bytes, mirroring the web gate. */
export async function saveImageAttachment(
  ctx: Context,
  data: Uint8Array,
  mediaType: string,
  name?: string,
): Promise<AdapterResult & { attachment?: AttachmentRefLike }> {
  const attachments = attachmentsOf(ctx);
  if (!attachments) return fail("attachments service is unavailable in this profile");
  try {
    const ref = await attachments.saveImage({ data, mediaType, ...(name === undefined ? {} : { name }) });
    return { ok: true, text: `\u{1F5BC} Attachment ${ref.attachmentId}`, attachment: ref };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** session.attachment read (base64, same as the web response). */
export async function readImageAttachment(ctx: Context, attachmentId: string): Promise<AdapterResult & { data?: string; mediaType?: string }> {
  const attachments = attachmentsOf(ctx);
  if (!attachments) return fail("attachments service is unavailable in this profile");
  try {
    const ref = await attachments.readImage({ attachmentId, mediaType: "image/png", bytes: 0, width: 0, height: 0 });
    return {
      ok: true,
      text: `\u{1F5BC} ${attachmentId} (${ref.data.byteLength} bytes)`,
      data: Buffer.from(ref.data).toString("base64"),
      mediaType: ref.ref.mediaType,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Deliver a promoted image into the session, as one followup turn. */
export function imagePrompt(ctx: Context, sessionId: string, attachment: AttachmentRefLike, caption?: string): AdapterResult {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (!agent) return fail(`session ${sessionId} has no live agent`);
  const content: unknown[] = [];
  if (caption) content.push({ type: "text", text: caption });
  content.push({ type: "image", attachment });
  const message = createUserMessage({ content: content as never, source: { kind: "user" } });
  try {
    (agent as unknown as { followup(message: unknown): void }).followup(message);
    return ok("Image delivered.");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function releaseModelSelection(sessionId: string): void {
  const entry = selections.get(sessionId);
  if (!entry) return;
  entry.dispose();
  selections.delete(sessionId);
}

export function releaseAllModelSelections(): void {
  for (const [sessionId, entry] of selections) {
    entry.dispose();
    selections.delete(sessionId);
  }
}

export interface CreatedSession {
  result: AdapterResult;
  agentId?: string;
}

/** Session-directory segment encoding (mirrors the JSONL backend's
 * `encodeSegment`: safe path segment, `--` wrapped, separators folded). */
function encodeSegment(text: string): string {
  let readable = "";
  let separatorRun = true;
  for (const ch of text) {
    if (ch === "/" || ch === "\\" || ch === "\u0000") {
      separatorRun = true;
      continue;
    }
    if (separatorRun) {
      readable += "~";
      separatorRun = false;
    }
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Delete one session entirely: dispose its live agent, drop the in-memory
 * model selection, and remove its durable session directory. There is no web
 * RPC for this — it is a Telegram-side convenience. */
export async function deleteSession(ctx: Context, sessionId: string): Promise<AdapterResult> {
  const agents = agentsOf(ctx);
  const agent = agents?.get(SessionId(sessionId));
  if (agent) {
    await (agent as unknown as { dispose(): Promise<void> }).dispose().catch(() => {});
    releaseModelSelection(sessionId);
  }
  const { dshHome } = await import("./mode.js");
  const root = join(dshHome(), "sessions");
  const encoded = encodeSegment(sessionId);
  let removed = false;
  try {
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const dir = join(root, project.name, encoded);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
        removed = true;
      }
    }
  } catch {
    /* scan errors are non-fatal */
  }
  return ok(`\u{1F5D1} Session ${sessionId} deleted${removed ? "" : " (no stored files)"}.`);
}

/**
 * Owns the agents this plugin created through `/new` so the previous one can
 * be torn down (and persisted by the session-persistence plugins) when a
 * fresh one replaces it.
 */
export class SessionLifecycle {
  private handle: AgentHandle | undefined;
  private readonly handles = new Map<string, AgentHandle>();

  /** Create a fresh agent+session in `cwd`, replacing the previously owned one. */
  /** Create a session. `model` (optional telegram-owned default) overrides
   * the profile default so the bot can run a different model than the web. */
  async create(ctx: Context, cwd: string, model?: { provider?: string; model?: string }): Promise<CreatedSession> {
    if (!ctx.agents) return { result: fail("agents service is unavailable in this profile") };
    const previousAgent = ctx.agents.list()[0];
    // First `/new` in a fresh process has no live agent to inherit from; fall
    // back to the profile default (mirrors the web ApiProxy's
    // defaultModelSelection() = ctx.agentDefaultModel.currentSelection()),
    // otherwise prompt assembly fails with `{{model}} has no value`.
    const defaultModel = (
      ctx.get("agentDefaultModel") as { currentSelection(): { provider: string; model: string } } | undefined
    )?.currentSelection();
    try {
      const handle = await ctx.agents.create({
        sessionId: SessionId(`telegram-${randomUUID()}`),
        meta: { cwd },
        agentOptions: {
          provider: model?.provider ?? previousAgent?.options.provider ?? defaultModel?.provider,
          model: model?.model ?? previousAgent?.options.model ?? defaultModel?.model,
        },
      });
      console.error(`[dsh-telegram] session create model=${handle.agent.options.model} provider=${handle.agent.options.provider} (telegram config: ${model?.provider ?? "-"}/${model?.model ?? "-"})`);
      const replaced = this.handle;
      this.handle = handle;
      this.handles.set(handle.agent.id, handle);
      if (replaced) {
        this.handles.delete(replaced.agent.id);
        void replaced
          .dispose()
          .catch((err) => console.error("[dsh-telegram] failed to dispose previous agent", err));
      }
      return {
        result: ok(`\u2728 New session ${handle.agent.id} in ${cwd}`),
        agentId: handle.agent.id,
      };
    } catch (err) {
      return { result: fail(err instanceof Error ? err.message : String(err)) };
    }
  }

  /** Resolve a live agent by id (agent id === session id). */
  find(ctx: Context, agentId: string) {
    return ctx.agents?.get(SessionId(agentId));
  }

  /** Track a handle this plugin did not create (e.g. a resumed fork). */
  adopt(handle: AgentHandle): void {
    this.handles.set(handle.agent.id, handle);
  }

  /** Close (dispose) one live agent tracked by this plugin. */
  async close(agentId: string): Promise<AdapterResult> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return fail(`no disposal handle for agent ${agentId}`);
    this.handles.delete(agentId);
    if (this.handle === handle) this.handle = undefined;
    await handle.dispose().catch((err) => console.error("[dsh-telegram] failed to dispose agent", err));
    return ok(`\u23F9 Closed ${agentId}`);
  }

  /** Cancel the current turn of one agent (defaults to the first live agent). */
  stop(ctx: Context, agentId?: string): AdapterResult {
    const agents = ctx.agents?.list() ?? [];
    const agent = agentId !== undefined ? agents.find((a) => a.id === agentId) : agents[0];
    if (!agent) return ok("Nothing is running.");
    agent.cancel({ kind: "user" }, { keepInbox: true });
    return ok(`\u23F9 Cancelling ${agent.id}\u2026`);
  }

  /** Plugin teardown: dispose every agent this plugin created or adopted. */
  async dispose(): Promise<void> {
    this.handle = undefined;
    const pending = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(pending.map((handle) => handle.dispose().catch(() => {})));
  }
}

export { MessageId };
