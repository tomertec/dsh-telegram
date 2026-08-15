/**
 * dsh-telegram: a native Telegram bridge for DeepSeek Harness.
 *
 * Assembly only — every capability lives in its own module:
 *   telegram/  : transport, queues, keyboards, panels (no dsh imports)
 *   harness/   : adapters + bridge (no grammy imports besides types)
 *
 * v0.2 wiring adds every web-exposed domain (sessions/workspace/goals/
 * feedback/skills/subagents/presets/settings/credentials/llm/host/commands/
 * jobs/downloads/plugins/dynamicCordis/approvals/questions) as a Telegram card.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent";
import type { CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-session";
import { existsSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { isChatAllowed, readConfig, resolveToken, writeConfig, overlayConfig, getConfigPath, patchFromPath, type ConfigSection, type TelegramConfig } from "./config.js";
import { Bridge } from "./harness/bridge.js";
import { compactCurrent } from "./harness/adapters/compact.js";
import { modeSummary } from "./harness/adapters/mode.js";
import { listPlugins, togglePlugin, entryIdFor } from "./harness/adapters/plugins.js";
import {
  listSessionDetails,
  searchSessions,
  readHistory,
  renameSession,
  forkSession,
  resumeSession,
  promptSession,
  deleteSession,
  selectSessionModel,
  currentSessionModel,
  listQueue,
  updateQueueItem,
  saveImageAttachment,
  SessionLifecycle,
  releaseAllModelSelections,
} from "./harness/adapters/sessions.js";
import { listWorkspaces, createWorkspace, renameWorkspace, deleteWorkspace, insertWorkspaceBefore, insertSessionBefore, archiveSession } from "./harness/adapters/workspace.js";
import { getGoal, createGoal, editGoal, pauseGoal, resumeGoal, completeGoal, clearGoal } from "./harness/adapters/goals.js";
import { listFeedback, putFeedback } from "./harness/adapters/feedback.js";
import { listSkills } from "./harness/adapters/skills.js";
import { listSubagents, promptSubagent, interruptSubagent, subagentHistory } from "./harness/adapters/subagents.js";
import { listAgentPresets, selectAgentPreset, setDefaultAgentPreset, readAgentPreset, copyAgentPreset, removeAgentPreset, openAgentPresetDocument, switchAgentPresetMidSession, sessionHasStarted } from "./harness/adapters/presets.js";
import { describeSettings, updateSettings } from "./harness/adapters/settings.js";
import { describeCredential, setCredential, unsetCredential } from "./harness/adapters/credentials.js";
import { modelCatalog, discoverModels } from "./harness/adapters/llm.js";
import { REASONING_DEFAULT, isReasoningEffort, reasoningLabel } from "./reasoning.js";
import { reasoningExtension } from "./extensions/reasoning.js";
import type { TelegramExtension, ExtensionHost } from "./extensions/types.js";
import { describeHost, listDirectory, createDirectory, isDirectory, parentOf } from "./harness/adapters/host.js";
import { listCommands, executeCommand } from "./harness/adapters/commands.js";
import { listJobs } from "./harness/adapters/jobs.js";
import { exportSessionLog } from "./harness/adapters/downloads.js";
import { listDynamicCordis } from "./harness/adapters/dynamicCordis.js";
import { probeCapabilities, missingServices } from "./harness/adapters/capabilities.js";
import { attachInteractive, type Interactive, questionIdAt } from "./harness/adapters/interactive.js";
import { resetStatusStats, statusSnapshot } from "./harness/adapters/status.js";
import { Ephemeral } from "./telegram/ephemeral.js";
import { plain, truncate } from "./telegram/html.js";
import {
  buildBackKeyboard,
  buildBarKeyboard,
  buildMenuPage,
  buildProjectKeyboard,
  queueBarLabel,
  type MenuItem,
  buildSessionsKeyboard,
  buildSessionDetailKeyboard,
  buildWorkspaceKeyboard,
  buildWorkspaceDetailKeyboard,
  buildQueueKeyboard,
  buildModelsKeyboard,
  buildModelDetailKeyboard,
  buildThinkingKeyboard,
  buildGoalsKeyboard,
  buildSkillsKeyboard,
  buildSubagentsKeyboard,
  buildSubagentDetailKeyboard,
  buildPresetsKeyboard,
  buildPresetDetailKeyboard,
  buildSettingsKeyboard,
  buildCredentialsKeyboard,
  buildHostKeyboard,
  buildJobsKeyboard,
  buildDynamicCordisKeyboard,
  buildCapabilitiesKeyboard,
  CALLBACK_RE,
  COMPACT_BTN,
  MENU_BTN,
  MODELS_BTN,
  MODE_BTN,
  NEW_BTN,
  PLUGINS_BTN,
  PRESETS_BTN,
  THINKING_BTN,
  REASONING_BTN,
  QUEUE_BTN,
  SESSIONS_BTN,
  STATUS_BTN,
  STOP_BTN,
} from "./telegram/keyboard.js";
import { SendQueue } from "./telegram/queue.js";
import { attachRouter } from "./telegram/router.js";
import { StatusPanel } from "./telegram/status-panel.js";
import { TelegramTransport } from "./telegram/transport.js";
import { findWorkspaceRoot } from "./workspace.js";

export const name = "dsh-telegram";
export const version = "0.2.0";
export const inject = ["tools", "commands", "agents"];

interface State {
  context: Context | null;
  /** Active project folder — new sessions are created under it. */
  workspaceRoot: string;
  /** Boot workspace that owns `.pi/telegram.json` (config never moves with the project). */
  configRoot: string;
  config: TelegramConfig;
  transport: TelegramTransport | undefined;
  bridge: Bridge | undefined;
  interactive: Interactive | undefined;
  watching: boolean;
  chats: Set<number>;
  /** Last queue count embedded in a bar per chat (live-count sync). */
  barCounts: Map<number, number>;
  /** Dedicated carrier message carrying the live bar, deletable on refresh. */
  barCarriers: Map<number, number>;
  /** Per-chat debounce timers for bar refreshes. */
  barTimers: Map<number, ReturnType<typeof setTimeout>>;
}

const state: State = {
  context: null,
  workspaceRoot: findWorkspaceRoot(process.cwd()) ?? process.cwd(),
  configRoot: findWorkspaceRoot(process.cwd()) ?? process.cwd(),
  config: readConfig(findWorkspaceRoot(process.cwd()) ?? process.cwd()),
  transport: undefined,
  bridge: undefined,
  interactive: undefined,
  watching: false,
  chats: new Set(),
  barCounts: new Map(),
  barCarriers: new Map(),
  barTimers: new Map(),
};

/** Reverse every live mount effect (hot unplug / HMR / config restart). */
function teardownMount(): void {
  state.interactive?.detach();
  state.interactive = undefined;
  state.bridge?.detach();
  state.bridge = undefined;
  void state.transport?.stop().catch(() => {});
  state.transport = undefined;
  state.watching = false;
  state.chats.clear();
  state.context = null;
  pendingRename = undefined;
  pendingSubagentPrompt = undefined;
  pendingQueueEdit = undefined;
  for (const timer of state.barTimers.values()) clearTimeout(timer);
  state.barTimers.clear();
  state.barCounts.clear();
  state.barCarriers.clear();
  releaseAllModelSelections();
  tokens.clear();
  menuPageIndex.clear();
  void sessionLifecycle.dispose().catch(() => {});
  ephemeral.reset();
  statusPanel.reset();
  resetStatusStats();
}

/** Apply a config patch live, without restarting polling or rebinding the agent. */
function applyConfigLive(changed: readonly ConfigSection[]): void {
  if (changed.includes("outbound")) {
    state.transport?.applyLimits({
      maxPerWindow: state.config.outbound.sendRatePerSecond,
      retry: { attempts: state.config.outbound.maxRetries, baseDelayMs: 500 },
      maxMessageLength: state.config.outbound.maxMessageLength,
    });
  }
  if (changed.includes("watch") && state.config.watch.autoStart && !state.watching) {
    void startWatching().catch((err) => log("auto start failed", err));
  }
  if (changed.includes("workspace")) {
    const activePath = state.config.workspace.activePath;
    if (activePath !== undefined && existsSync(activePath)) {
      state.workspaceRoot = activePath;
    }
  }
  refreshAllPanels();
}

const ephemeral = new Ephemeral();
const statusPanel = new StatusPanel();
const sessionLifecycle = new SessionLifecycle();

/** Callback payload registry: keeps long ids out of the 64-byte data limit. */
const tokens = new Map<number, Record<string, string>>();
let tokenCounter = Date.now();
function token(payload: Record<string, string>): string {
  tokenCounter += 1;
  tokens.set(tokenCounter, payload);
  return `t:${tokenCounter}`;
}

/** Registered domain extensions. Core only dispatches to them; it owns no
 * card/callback/command logic of its own beyond the bridge skeleton. */
const extensions: TelegramExtension[] = [];

function registerExtension(extension: TelegramExtension): void {
  extensions.push(extension);
}

function buildExtensionHost(): ExtensionHost {
  return {
    openCard,
    send: (chatId, text, options) => requireTransport().sendText(chatId, text, options as never),
    token,
    currentAgent,
    requireCtx,
    workspaceRoot: () => state.workspaceRoot,
    getConfigPath: (path) => getConfigPath(state.config, path),
    applyConfig: (patch) => {
      const { config, changed } = overlayConfig(state.config, patch);
      if (changed.length === 0) return changed;
      state.config = config;
      applyConfigLive(changed);
      writeConfig(state.configRoot, state.config);
      return changed;
    },
    refreshAllPanels,
    editMessage: (chatId, messageId, text, options) => requireTransport().editText(chatId, messageId, text, options as never),
    deleteMessage: (chatId, messageId) => requireTransport().deleteMessage(chatId, messageId),
    statusStats: () => statusSnapshot(requireCtx(), boundAgentId()).stats,
    currentAgentId: () => state.bridge?.currentAgentIdValue(),
    currentChatId: () => state.bridge?.activeChatValue(),
    setAssistantConsumer: (consumer) => {
      state.bridge?.setAssistantConsumer(consumer);
    },
    pendingInbound: () => state.bridge?.hasPendingInbound() ?? false,
    markInboundReplied: () => {
      state.bridge?.markInboundReplied();
    },
  };
}

/** Hot-plug UI refresh: reopen open menu cards and refresh panels so a
 * just-registered/removed extension is visible without a restart. */
function refreshExtensionUi(): void {
  refreshAllPanels();
  for (const [chatId, page] of [...menuPageIndex]) {
    void openMenuAt(chatId, page).catch(() => {});
  }
}

function extensionForCallback(action: string) {
  for (const extension of extensions) {
    const handler = extension.callbacks?.[action];
    if (handler) return { extension, handler };
  }
  return undefined;
}

function extensionForCommand(command: string) {
  for (const extension of extensions) {
    const handler = extension.commands?.[command];
    if (handler) return { extension, handler };
  }
  return undefined;
}

function extensionForBar(label: string) {
  for (const extension of extensions) {
    const handler = extension.barButtons?.[label];
    if (handler) return { extension, handler };
  }
  return undefined;
}

function log(message: string, error?: unknown): void {
  console.error(`[dsh-telegram] ${message}`, error ?? "");
}

function textOutput() {
  return {
    schema: { type: "string" as const },
    render: (_args: Record<string, unknown>, value: string) => [{ type: "text" as const, text: value }],
  };
}

function validateParseMode(value: unknown): "HTML" | undefined {
  return value === "HTML" ? "HTML" : undefined;
}

const okCmd = (text: string): CommandResult => ({ kind: "success", text });
const failCmd = (text: string): CommandResult => ({ kind: "error", text });

function requireTransport(): TelegramTransport {
  if (!state.transport) throw new Error("Telegram is not running: set TELEGRAM_BOT_TOKEN and send /telegram start.");
  return state.transport;
}

/** Per-chat typing refreshers: Telegram's "typing" action expires after ~5s,
 * so long agent turns re-assert it every 4s until turn/end stops it. */
const typingLoops = new Map<number, ReturnType<typeof setInterval>>();

function startTyping(chatId: number): void {
  stopTyping(chatId);
  const transport = state.transport;
  if (!transport) return;
  void transport.sendChatAction(chatId, "typing").catch(() => {});
  typingLoops.set(
    chatId,
    setInterval(() => {
      void transport.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000),
  );
}

function stopTyping(chatId: number): void {
  const timer = typingLoops.get(chatId);
  if (timer !== undefined) {
    clearInterval(timer);
    typingLoops.delete(chatId);
  }
}

import { renderStatsStrip } from "./harness/adapters/status.js";
export { renderStatsStrip };
function renderStatus(): string {
  const snapshot = statusSnapshot(requireCtx(), boundAgentId());
  const profile = modeSummary().profile ?? "?";
  const workspace = state.workspaceRoot;
  const lines = [
    `\u{1F916} dsh \u00B7 ${plain(profile)} \u00B7 ${snapshot.status}`,
    "",
    `\u{1F4C1} Project: ${plain(truncate(workspace, 32))}`,
    `\u{1F3AD} Preset: ${snapshot.preset ? plain(snapshot.preset) : "default"}`,
    `\u{1F9E0} Reasoning: ${plain(reasoningLabel(currentReasoningEffort()))}`,
    `\u{1F9E9} Model: ${snapshot.provider ? `${plain(snapshot.provider)}/` : ""}${snapshot.model ? plain(snapshot.model) : "default"}`,
    `\u{1F916} Agent: ${snapshot.agentId ? plain(truncate(snapshot.agentId, 28)) : "none"}`,
    "",
    `\u{1F4CA} Queue: ${snapshot.queue} \u00B7 Sessions: ${snapshot.sessions}`,
    `\u{1F4E1} Bot: ${state.watching ? "polling" : state.transport ? "standby" : "offline"} \u00B7 Pending: ${state.transport?.pending() ?? 0}`,
  ];
  if (snapshot.stats) {
    const strip = renderStatsStrip(snapshot.stats);
    if (strip !== undefined) lines.push("", strip);
  }
  return lines.join("\n");
}

function requireCtx(): Context {
  if (!state.context) throw new Error("dsh-telegram context is not attached");
  return state.context;
}

function boundAgentId(): string | undefined {
  return state.bridge?.currentAgentIdValue();
}

function currentAgent(): Agent | undefined {
  const ctx = requireCtx();
  const id = boundAgentId();
  const agents = ctx.agents?.list() ?? [];
  if (id !== undefined) {
    const bound = ctx.agents?.get(id as never);
    if (bound) return bound;
  }
  return agents[0];
}

async function openCard(chatId: number, text: string, keyboard: unknown): Promise<void> {
  const t = requireTransport();
  await ephemeral.replace(chatId, t, text, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

const menuPageIndex = new Map<number, number>();

/** Telegram sizes the bubble (and its inline keyboard) to the widest text
 * line. A trailing line of non-breaking spaces forces the card to span the
 * maximum bubble width so keyboard rows never leave a right-hand gap. */
function widenCard(text: string): string {
  return `${text}\n${"\u00A0".repeat(80)}`;
}

/** Paginated core menu. Page 0 = non-bar frequent actions; bar-mirrored
 * functions live on page 1; display-only/rare cards on pages 2-3. */
async function openMenuAt(chatId: number, page: number): Promise<void> {
  const snapshot = statusSnapshot(requireCtx(), boundAgentId());
  const model = snapshot.provider ? `${snapshot.provider}/${snapshot.model ?? "default"}` : (snapshot.model ?? "default");
  const project = basename(state.workspaceRoot) || "/";
  const mode = state.config.mode?.name || modeSummary().profile || "default";
  const pages: MenuItem[][] = [
    [
      { label: `\u2728 New session \u00B7 ${project}`, cb: "m:new", full: true },
      { label: `\u{1F4C1} Project \u00B7 ${project}`, cb: "m:project", full: true },
      ...extensions.flatMap((extension) => extension.menuItems?.(buildExtensionHost()) ?? []),
      { label: "\u{1F3AF} Goals", cb: "m:goals" },
      { label: "\u{1F5C2} Workspaces", cb: "m:workspaces" },
      { label: "\u{1F9EC} Skills", cb: "m:skills" },
      { label: "\u{1F916} Subagents", cb: "m:subagents" },
      { label: "\u{1F4CB} Jobs", cb: "m:jobs" },
      { label: "\u269B\uFE0F Dynamic", cb: "m:dynamic" },
      { label: "\u{1F4BB} Host", cb: "m:host" },
      { label: "\u{1F9EC} Capabilities", cb: "m:capabilities" },
      { label: "\u{1F4E1} Watch", cb: "m:watch" },
    ],
    [
      { label: `\u231B Queue \u00B7 ${snapshot.queue}`, cb: "m:queue" },
      { label: `\u{1F9E9} Models \u00B7 ${model}`, cb: "m:models" },
      { label: `\u{1F3AD} Mode \u00B7 ${mode}`, cb: "m:mode" },
      { label: "\u{1F9ED} Sessions", cb: "m:sessions" },
      { label: "\u{1F4CA} Status", cb: "m:status" },
      { label: "\u{1F50C} Plugins", cb: "m:plugins" },
      { label: "\u{1F9F9} Compact", cb: "m:compact" },
      { label: "\u23F9 Stop", cb: "m:stop" },
      { label: "\u{1F6E0}\uFE0F Host settings", cb: "m:hostsettings" },
      { label: "\u{1F511} Credentials", cb: "m:credentials" },
      { label: "\u{1F510} Allowed", cb: "m:allowed" },
      { label: "\u2699\uFE0F Settings", cb: "m:settings" },
      { label: "\u2139\uFE0F About", cb: "m:about" },
      { label: "\u{1F3AD} Presets", cb: "m:presets" },
    ],
  ];
  const safe = Math.max(0, Math.min(page, pages.length - 1));
  menuPageIndex.set(chatId, safe);
  const header = safe === 0 ? renderStatus() : `\u2630 Menu \u00B7 page ${safe + 1}/${pages.length}`;
  await openCard(chatId, widenCard(header), buildMenuPage(pages[safe]!, safe, pages.length));
}

// ---------------------------------------------------------------------------
// Domain cards
// ---------------------------------------------------------------------------

async function openModelsCard(chatId: number): Promise<void> {
  const ctx = requireCtx();
  const agent = currentAgent();
  const current = agent ? currentSessionModel(ctx, agent.id) : {};
  const catalog = await modelCatalog(ctx, current);
  const lines = [
    `\u{1F9E9} Models \u00B7 current: ${current.provider ? `${plain(current.provider)}/` : ""}${plain(current.model ?? "default")}${current.reasoningEffort ? ` (${plain(current.reasoningEffort)})` : ""}`,
    "",
  ];
  for (const group of catalog.groups) {
    lines.push(`\u2022 ${plain(group.name)} (${plain(group.id)})`);
    for (const model of group.models.slice(0, 12)) lines.push(`  \u2212 ${plain(truncate(model.id, 40))}`);
    if (group.models.length > 12) lines.push(`  \u2026 +${group.models.length - 12}`);
  }
  for (const failure of catalog.failures) lines.push(`\u26A0\uFE0F ${plain(failure.provider)}: ${plain(failure.message)}`);
  lines.push("", "Tap a provider to switch the current session's model.");
  log(`models card: groups=${catalog.groups.map((g) => g.id).join(",")} failures=${catalog.failures.length}`);
  await openCard(chatId, lines.join("\n"), buildModelsKeyboard(catalog.groups));
}

async function openProviderModelsCard(chatId: number, providerId: string): Promise<void> {
  const ctx = requireCtx();
  const agent = currentAgent();
  const current = agent ? currentSessionModel(ctx, agent.id) : {};
  const catalog = await modelCatalog(ctx, current);
  const group = catalog.groups.find((candidate) => candidate.id === providerId);
  log(`provider card requested=${providerId} groups=${catalog.groups.map((g) => g.id).join(",")} found=${group !== undefined}`);
  if (!group) return openModelsCard(chatId);
  const lines = [`\u{1F4E1} ${plain(group.name)}`, "", `current: ${current.provider === providerId ? plain(current.model ?? "default") : "other provider"}`, ""];
  const models = group.models.slice(0, 20).map((model) => ({
    id: model.id,
    name: model.name,
    cb: token({ action: "model-select", provider: providerId, model: model.id }),
  }));
  for (const model of models) {
    lines.push(`${current.provider === providerId && current.model === model.id ? "\u2705" : "\u25CB"} ${plain(truncate(model.id, 40))}`);
    if (model.name !== model.id) lines.push(`   ${plain(truncate(model.name, 40))}`);
  }
  await openCard(chatId, lines.join("\n"), buildModelDetailKeyboard(models));
}

/** Current reasoning effort from the live config (default medium). */
function currentReasoningEffort(): "minimal" | "low" | "medium" | "high" | "max" {
  const effort = state.config.reasoning?.effort;
  return effort !== undefined && isReasoningEffort(effort) ? effort : REASONING_DEFAULT;
}

/** Reasoning-effort picker card: the fixed codex-telegram-bot levels. */
async function openPluginsCard(chatId: number): Promise<void> {
  const ctx = requireCtx();
  const plugins = listPlugins(ctx);
  const lines = [`\u{1F50C} Plugins (${plugins.length})`, ""];
  for (const plugin of plugins.slice(0, 30)) {
    lines.push(`${plugin.enabled ? "\u2705" : "\u26AA"} ${plain(truncate(plugin.moduleName ?? plugin.entryId, 36))} \u00B7 ${plain(plugin.fiberPhase ?? "\u2014")}`);
  }
  const dynamic = listDynamicCordis(ctx);
  if (dynamic.length > 0) {
    lines.push("", `Dynamic plugin packages: ${dynamic.length}`);
    for (const row of dynamic.slice(0, 10)) lines.push(`\u2022 ${plain(String(row.pluginId))}`);
  }
  lines.push("", "Toggle: /pluginenable <name> \u00B7 /plugindisable <name>");
  const kb = buildBackKeyboard();
  await openCard(chatId, lines.join("\n"), kb);
}

async function openSessionsCard(chatId: number): Promise<void> {
  const ctx = requireCtx();
  const details = await listSessionDetails(ctx);
  const current = state.bridge?.currentAgentIdValue();
  const lines = [`\u{1F9ED} Sessions (${details.length})`, ""];
  for (const session of details.slice(0, 15)) {
    const flags = [session.live ? "live" : "cold", session.running ? "running" : "idle"];
    if (session.archived) flags.push("archived");
    lines.push(
      `${session.id === current ? "\u25B8" : "\u2022"} ${plain(truncate(session.id, 32))} \u00B7 ${flags.join("/")}${session.title ? ` \u00B7 ${plain(truncate(session.title, 24))}` : ""}`,
    );
    if (session.lastPromptAt !== undefined) lines.push(`   last prompt: ${plain(new Date(session.lastPromptAt).toLocaleString())}`);
  }
  lines.push("", "Tap a session for Use/History/Rename/Fork/Archive/Model/Queue.");
  await openCard(chatId, lines.join("\n"), buildSessionsKeyboard(details.map((session) => session.id)));
}

async function openSessionDetailCard(chatId: number, sessionId: string): Promise<void> {
  const ctx = requireCtx();
  const details = await listSessionDetails(ctx);
  const session = details.find((candidate) => candidate.id === sessionId);
  if (!session) {
    await requireTransport().sendText(chatId, `\u274C Session ${plain(truncate(sessionId, 32))} not found.`, { parse_mode: "HTML" });
    return openSessionsCard(chatId);
  }
  const lines = [
    `\u{1F9ED} ${plain(truncate(session.id, 40))}`,
    "",
    `live: ${session.live} \u00B7 running: ${session.running} \u00B7 blank: ${session.blank} \u00B7 archived: ${session.archived}`,
    `events: ${session.eventCount}${session.cwd ? ` \u00B7 cwd: ${plain(truncate(session.cwd, 28))}` : ""}`,
    session.title ? `title: ${plain(session.title)}` : "title: (none)",
    session.lastPromptAt !== undefined ? `last prompt: ${plain(new Date(session.lastPromptAt).toLocaleString())}` : "",
  ].filter((line) => line !== "");
  await openCard(chatId, lines.join("\n"), buildSessionDetailKeyboard(session.id, session.archived));
}

async function openHistoryCard(chatId: number, sessionId: string, beforeSeq?: number): Promise<void> {
  const items = await readHistory(requireCtx(), sessionId, 20, beforeSeq);
  const lines = [`\u{1F4DC} History \u00B7 ${plain(truncate(sessionId, 32))} (${items.length})`, ""];
  for (const item of items) {
    lines.push(`[${item.seq}] ${item.role === "user" ? "\u{1F464}" : item.role === "assistant" ? "\u{1F916}" : "\u2699\uFE0F"} ${plain(truncate(item.text, 120))}`);
  }
  if (items.length === 0) lines.push("(no events)");
  const kb = buildSessionDetailKeyboard(sessionId, false);
  await openCard(chatId, lines.join("\n"), kb);
}

async function openSearchCard(chatId: number, query: string): Promise<void> {
  const hits = await searchSessions(requireCtx(), query, 20);
  const lines = [`\u{1F50D} Search "${plain(truncate(query, 40))}" \u2014 ${hits.length} hit(s)`, ""];
  for (const hit of hits.slice(0, 10)) {
    lines.push(`\u2022 ${plain(truncate(hit.sessionId, 24))} [${hit.seq}] ${hit.type}${hit.live ? "" : " (cold)"}`);
    lines.push(`  ${plain(truncate(hit.snippet, 80))}`);
  }
  await openCard(chatId, lines.join("\n"), buildSessionsKeyboard(hits.slice(0, 8).map((hit) => hit.sessionId)));
}

async function openQueueCard(chatId: number): Promise<void> {
  const ctx = requireCtx();
  const agent = currentAgent();
  const snapshot = statusSnapshot(ctx, boundAgentId());
  const items = agent ? listQueue(ctx, agent.id) : [];
  const lines = [`\u231B Queue`, "", `Agent inbox: ${snapshot.queue} \u00B7 Outbound sends pending: ${state.transport?.pending() ?? 0}`, ""];
  for (const item of items.slice(0, 12)) {
    lines.push(`\u2022 ${item.target === "next-turn" ? "turn" : "step"} [${item.itemId.slice(0, 8)}] ${plain(truncate(item.text, 40))}`);
  }
  if (items.length === 0) {
    lines.push("(nothing pending)", "", "\u{1F4A1} \u8FDE\u7EED\u53D1\u4E24\u6761\u6D88\u606F\uFF0C\u7B2C\u4E8C\u6761\u4F1A\u6392\u961F\uFF0C\u6BCF\u6761\u90FD\u6709 \u270F/\u{1F5D1}/\u26A1 \u6309\u94AE\u3002");
  } else {
    lines.push("", "\u270F \u7F16\u8F91 \u00B7 \u{1F5D1} \u5220\u9664 \u00B7 \u26A1 \u7ACB\u5373\u6267\u884C(\u4EC5 next-turn) \u2014 \u6309\u4E0B\u65B9\u6309\u94AE\u64CD\u4F5C");
  }
  await openCard(chatId, lines.join("\n"), buildQueueKeyboard(items.map((item) => ({ itemId: item.itemId, kind: item.target }))));
}

async function openWorkspacesCard(chatId: number): Promise<void> {
  const { items, archivedSessionIds } = listWorkspaces(requireCtx());
  const lines = [`\u{1F5C2} Workspaces (${items.length})`, ""];
  for (const workspace of items.slice(0, 15)) {
    lines.push(`\u2022 ${plain(truncate(workspace.title, 28))} \u00B7 ${plain(truncate(workspace.path, 24))}`);
    lines.push(`  sessions: ${workspace.sessionIds.length} \u00B7 id: ${plain(truncate(workspace.workspaceId, 20))}`);
  }
  if (items.length === 0) lines.push("No workspaces registered \u2014 /workspacecreate <path> [title]");
  if (archivedSessionIds.length > 0) lines.push("", `Archived sessions: ${archivedSessionIds.length}`);
  await openCard(chatId, lines.join("\n"), buildWorkspaceKeyboard(items.map((workspace) => ({ id: workspace.workspaceId, title: workspace.title }))));
}

async function openWorkspaceDetailCard(chatId: number, workspaceId: string): Promise<void> {
  const { items } = listWorkspaces(requireCtx());
  const workspace = items.find((candidate) => candidate.workspaceId === workspaceId);
  if (!workspace) return openWorkspacesCard(chatId);
  const lines = [
    `\u{1F5C2} ${plain(truncate(workspace.title, 40))}`,
    "",
    `path: ${plain(truncate(workspace.path, 60))}`,
    `id: ${plain(truncate(workspace.workspaceId, 32))}`,
    `sessions (${workspace.sessionIds.length}): ${workspace.sessionIds.slice(0, 6).map((id) => plain(truncate(id, 16))).join(", ")}${workspace.sessionIds.length > 6 ? "\u2026" : ""}`,
    workspace.createdAt !== undefined ? `created: ${plain(new Date(workspace.createdAt).toLocaleString())}` : "",
    workspace.updatedAt !== undefined ? `updated: ${plain(new Date(workspace.updatedAt).toLocaleString())}` : "",
  ].filter((line) => line !== "");
  await openCard(chatId, lines.join("\n"), buildWorkspaceDetailKeyboard(workspaceId));
}

/** Codex-style project picker: browse folders inline, then use one as the
 * active project for all new sessions. */
const PROJECT_PAGE_SIZE = 24;

async function openProjectCard(chatId: number, target?: string, offset = 0): Promise<void> {
  const path = target ?? state.workspaceRoot;

  const workspacePaths = listWorkspaces(requireCtx()).items.map((workspace) => workspace.path);
  const quick = [...new Set(workspacePaths.filter((candidate) => candidate !== path))].slice(0, 3).map((candidate) => ({
    label: `\u{1F5C2} ${basename(candidate)}`,
    cb: token({ action: "project-open", path: candidate }),
  }));

  const baseActions = {
      up: path === "/" ? undefined : token({ action: "project-up", path }),
      home: path === homedir() ? undefined : token({ action: "project-open", path: homedir() }),
      root: path === "/" ? undefined : token({ action: "project-open", path: "/" }),
      close: "m:close",
      quick,
  };

  if (!(await isDirectory(path))) {
    const lines = [`\u{1F4C1} ${plain(truncate(path, 60))}`, "", "\u274C Not a directory (or not readable).", "", "Go up a level, or pick a quick root below."];
    await openCard(chatId, lines.join("\n"), buildProjectKeyboard([], baseActions));
    return;
  }

  const listing = await listDirectory(path);
  if (!listing.ok) {
    const lines = [`\u{1F4C1} ${plain(truncate(path, 60))}`, "", `\u274C ${plain(listing.text)}`, "", "The folder itself is valid \u2014 use it as the project, or go up."];
    await openCard(chatId, lines.join("\n"), buildProjectKeyboard([], { ...baseActions, use: token({ action: "project-select", path }) }));
    return;
  }

  const entries = listing.entries ?? [];
  const dirs = entries.filter((entry) => entry.kind === "directory");
  const files = entries.length - dirs.length;
  const active = path === state.workspaceRoot ? " \u00B7 \u2705 current project" : "";
  const lines = [
    `\u{1F4C1} ${plain(truncate(path, 60))}${active}`,
    "",
    `folders: ${dirs.length} \u00B7 files: ${files}`,
    "",
    "Pick a folder to open it, or use this one as the project.",
  ];
  const page = dirs.slice(offset, offset + PROJECT_PAGE_SIZE).map((entry) => ({ label: entry.name, cb: token({ action: "project-open", path: joinPath(path, entry.name) }) }));
  const paging: { text: string; cb: string }[] = [];
  if (offset > 0) paging.push({ text: "\u2B05\uFE0F Prev", cb: token({ action: "project-open", path, offset: String(Math.max(0, offset - PROJECT_PAGE_SIZE)) }) });
  if (offset + PROJECT_PAGE_SIZE < dirs.length) paging.push({ text: "Next \u27A1\uFE0F", cb: token({ action: "project-open", path, offset: String(offset + PROJECT_PAGE_SIZE) }) });
  await openCard(
    chatId,
    lines.join("\n"),
    buildProjectKeyboard(page, {
      ...baseActions,
      paging,
      use: token({ action: "project-select", path }),
    }),
  );
}

function joinPath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}

/** Validate, switch, persist, and register the picked project folder. */
async function applyProjectPath(chatId: number, raw: string): Promise<void> {
  const tilde = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
  const target = tilde === "" ? state.workspaceRoot : resolve(tilde.startsWith("/") ? tilde : joinPath(state.workspaceRoot, tilde));
  const path = target;
  if (!(await isDirectory(path))) {
    await requireTransport().sendText(chatId, `\u274C Not a directory: ${plain(truncate(path, 60))}`, { parse_mode: "HTML" });
    return openProjectCard(chatId, path);
  }
  state.workspaceRoot = path;
  state.config.workspace.activePath = path;
  writeConfig(state.configRoot, state.config);
  const registry = requireCtx().get("workspaceRegistry");
  if (registry) {
    const anyRegistry = registry as { list(): { path: string }[]; create(path: string, title?: string): Promise<unknown> };
    const existing = anyRegistry.list().find((workspace) => workspace.path === path);
    if (!existing) {
      await anyRegistry.create(path, basename(path) || path).catch((err) => log("project register failed", err));
    }
  }
  await requireTransport().sendText(chatId, `\u{1F4C1} Project set: ${plain(path)}\n\u2728 New sessions will be created here.`, { parse_mode: "HTML" });
  return openMenuAt(chatId, 0);
}

async function openGoalsCard(chatId: number): Promise<void> {
  const agent = currentAgent();
  const lines = ["\u{1F3AF} Goal", ""];
  let hasGoal = false;
  if (agent) {
    const goal = getGoal(requireCtx(), agent.id);
    if (goal) {
      hasGoal = true;
      lines.push(`phase: ${goal.phase} \u00B7 activation: ${goal.activation} \u00B7 rounds: ${goal.roundsStarted}${goal.maxGoalRounds !== undefined ? `/${goal.maxGoalRounds}` : ""}`);
      lines.push(`objective: ${plain(truncate(goal.objective, 120))}`);
      lines.push(`revision: ${goal.revision} \u00B7 created: ${plain(new Date(goal.createdAt).toLocaleString())}`);
    } else {
      lines.push("(no current goal)");
    }
  } else {
    lines.push("No live agent \u2014 goals are per-agent.");
  }
  const goalPayload = agent ? { action: "goal", agentId: agent.id } : { action: "goal", agentId: "" };
  const callbacks = {
    create: token({ ...goalPayload, op: "create" }),
    edit: token({ ...goalPayload, op: "edit" }),
    pause: token({ ...goalPayload, op: "pause" }),
    resume: token({ ...goalPayload, op: "resume" }),
    complete: token({ ...goalPayload, op: "complete" }),
    clear: token({ ...goalPayload, op: "clear" }),
  };
  lines.push("", "Edit: /goaledit <text> \u00B7 Create: /goalcreate <objective> [maxRounds]");
  await openCard(chatId, lines.join("\n"), buildGoalsKeyboard(hasGoal, callbacks));
}

async function openSkillsCard(chatId: number): Promise<void> {
  const skills = await listSkills(requireCtx());
  const lines = [`\u{1F9D1}\u200D\u{1F3EB} Skills (${skills.length})`, ""];
  for (const skill of skills.slice(0, 30)) {
    lines.push(`\u2022 ${plain(skill.name)} \u00B7 ${plain(skill.source)}`);
    lines.push(`  ${plain(truncate(skill.description, 80))}`);
    lines.push(`  model:${skill.modelInvocable ? "yes" : "no"} user:${skill.userInvocable ? "yes" : "no"} provider: ${plain(skill.provider)}`);
  }
  if (skills.length === 0) lines.push("No skills registered in this profile.");
  await openCard(chatId, lines.join("\n"), buildSkillsKeyboard());
}

async function openSubagentsCard(chatId: number): Promise<void> {
  const agent = currentAgent();
  if (!agent) {
    await openCard(chatId, "No live agent \u2014 subagents hang off a parent session.", buildBackKeyboard());
    return;
  }
  const entries = await listSubagents(requireCtx(), agent.id);
  const lines = [`\u{1F916} Subagents of ${plain(truncate(agent.id, 24))} (${entries.length})`, ""];
  for (const entry of entries.slice(0, 15)) lines.push(`\u2022 ${plain(truncate(entry.id, 28))} \u00B7 ${entry.kind} \u00B7 ${entry.activity}`);
  if (entries.length === 0) lines.push("(none)");
  const rows = entries.slice(0, 12).map((entry) => ({ id: entry.id, cb: token({ action: "subagent", parentId: agent.id, childId: entry.id }) }));
  await openCard(chatId, lines.join("\n"), buildSubagentsKeyboard(rows));
}

async function openSubagentDetailCard(chatId: number, parentId: string, childId: string): Promise<void> {
  const lines = [`\u{1F916} ${plain(truncate(childId, 32))}`, "", `parent: ${plain(truncate(parentId, 24))}`, "", "Prompt: /subagentprompt <text>"];
  const callbacks = {
    prompt: token({ action: "subagent-prompt", parentId, childId }),
    interrupt: token({ action: "subagent-interrupt", parentId, childId }),
    history: token({ action: "subagent-history", parentId, childId }),
  };
  await openCard(chatId, lines.join("\n"), buildSubagentDetailKeyboard(callbacks));
}

async function openPresetsCard(chatId: number): Promise<void> {
  const { presets, authorable } = await listAgentPresets(requireCtx());
  const lines = [`\u{1F3AD} Agent presets (${presets.length}) \u00B7 authorable: ${authorable}`, ""];
  for (const preset of presets.slice(0, 20)) {
    lines.push(`${preset.isDefault ? "\u2B50" : "\u2022"} ${plain(preset.id)} \u00B7 ${preset.trust}${preset.broken ? " \u00B7 broken" : ""}`);
    if (preset.description) lines.push(`  ${plain(truncate(preset.description, 60))}`);
  }
  if (presets.length === 0) lines.push("This profile composes no agent presets.");
  const rows = presets.slice(0, 12).map((preset) => ({ id: preset.id, cb: token({ action: "preset", presetId: preset.id }) }));
  await openCard(chatId, lines.join("\n"), buildPresetsKeyboard(rows));
}

async function openPresetDetailCard(chatId: number, presetId: string): Promise<void> {
  const agent = currentAgent();
  const lines = [
    `\u{1F3AD} ${plain(truncate(presetId, 40))}`,
    "",
    "Blank session: applies in place. Started session: forks it, applies the preset to the fork, and closes the original.",
  ];
  const callbacks = {
    select: token({ action: "preset-select", presetId, sessionId: agent?.id ?? "" }),
    read: token({ action: "preset-read", presetId }),
    copy: token({ action: "preset-copy", presetId }),
    remove: token({ action: "preset-remove", presetId }),
    open: token({ action: "preset-open", presetId }),
    default: token({ action: "preset-default", presetId }),
  };
  await openCard(chatId, lines.join("\n"), buildPresetDetailKeyboard(callbacks));
}

async function openHostSettingsCard(chatId: number): Promise<void> {
  const { writable, hasDocument, documentPath, namespaces } = describeSettings(requireCtx());
  const lines = [`\u2699\uFE0F Host settings \u00B7 writable: ${writable} \u00B7 document: ${hasDocument ? plain(truncate(documentPath ?? "yes", 48)) : "none"}`, ""];
  for (const ns of namespaces.slice(0, 15)) {
    const secrets = ns.secrets.filter((secret) => secret.set).length;
    lines.push(`\u2022 ${plain(truncate(ns.ns, 36))} \u00B7 applies: ${ns.applies} \u00B7 rev ${ns.revision} \u00B7 secrets set: ${secrets}`);
  }
  if (namespaces.length === 0) lines.push("No settings namespaces registered.");
  lines.push("", "Describe: /settingsdescribe [ns] \u00B7 Update: /settingsupdate <ns> <json patch>");
  await openCard(chatId, lines.join("\n"), buildSettingsKeyboard(namespaces.map((ns) => ns.ns)));
}

async function openSettingsNamespaceCard(chatId: number, ns: string): Promise<void> {
  const { namespaces } = describeSettings(requireCtx());
  const view = namespaces.find((candidate) => candidate.ns === ns);
  if (!view) return openHostSettingsCard(chatId);
  const lines = [
    `\u2699\uFE0F ${plain(truncate(ns, 40))}`,
    "",
    `applies: ${view.applies} \u00B7 revision: ${view.revision}`,
    `value: ${plain(truncate(JSON.stringify(view.value), 300))}`,
    view.user !== undefined ? `user: ${plain(truncate(JSON.stringify(view.user), 200))}` : "",
    `secrets: ${view.secrets.map((secret) => `${secret.path.join(".")}=${secret.set ? "set" : "unset"}`).join(", ") || "none"}`,
  ].filter((line) => line !== "");
  await openCard(chatId, lines.join("\n"), buildSettingsKeyboard([ns]));
}

async function openCredentialsCard(chatId: number): Promise<void> {
  const lines = [
    "\u{1F511} Credentials",
    "",
    "Describe: /credential <REF> (configured/source/writable, value never shown)",
    "Set: /credentialset <REF> <value> \u00B7 Unset: /credentialunset <REF>",
    "",
    "The secret value never rides back \u2014 same as the web form.",
  ];
  await openCard(chatId, lines.join("\n"), buildCredentialsKeyboard());
}

async function openHostCard(chatId: number): Promise<void> {
  const host = describeHost(requireCtx(), state.workspaceRoot);
  const lines = [
    "\u{1F5A5} Host",
    "",
    `version: ${host.version} \u00B7 cwd: ${plain(truncate(host.cwd, 40))}`,
    `model default: ${host.provider ? `${plain(host.provider)}/` : ""}${host.model ? plain(host.model) : "default"}`,
    `attached sessions: ${host.attachedSessions} \u00B7 canOpenPath: ${host.canOpenPath}`,
    "",
    "List: /ls [path] \u00B7 Mkdir: /mkdir <path>",
  ];
  await openCard(chatId, lines.join("\n"), buildHostKeyboard());
}

async function openJobsCard(chatId: number): Promise<void> {
  const agent = currentAgent();
  const jobs = listJobs(requireCtx(), agent?.id);
  const lines = [`\u{1F527} Jobs (${jobs.length})`, ""];
  for (const job of jobs.slice(0, 20)) {
    lines.push(`\u2022 ${plain(job.kind)} [${plain(job.id)}] \u00B7 ${job.status}${job.detail ? ` \u00B7 ${plain(truncate(job.detail, 30))}` : ""}`);
    lines.push(`  ${plain(truncate(job.label, 60))} \u00B7 started ${plain(new Date(job.startedAt).toLocaleString())}`);
  }
  if (jobs.length === 0) lines.push("(none)");
  await openCard(chatId, lines.join("\n"), buildJobsKeyboard());
}

async function openDynamicCordisCard(chatId: number): Promise<void> {
  const rows = listDynamicCordis(requireCtx());
  const lines = [`\u{1F9F0} Dynamic plugin packages (${rows.length})`, ""];
  for (const row of rows.slice(0, 15)) {
    lines.push(`\u2022 ${plain(String(row.pluginId))}${row.packageId === undefined ? "" : ` \u00B7 ${plain(String(row.packageId))}`}${row.status === undefined ? "" : ` \u00B7 ${plain(String(row.status))}`}`);
  }
  lines.push("", "Run/stop/dependency controls are web panel operations \u2014 use the web UI for those.");
  await openCard(chatId, lines.join("\n"), buildDynamicCordisKeyboard());
}

async function openCapabilitiesCard(chatId: number): Promise<void> {
  const caps = probeCapabilities(requireCtx());
  const lines = ["\u{1F9E9} Host capabilities", ""];
  for (const [key, available] of Object.entries(caps) as [string, boolean][]) {
    lines.push(`${available ? "\u2705" : "\u274C"} ${plain(key)}`);
  }
  const missing = missingServices(requireCtx());
  if (missing.length > 0) lines.push("", `Missing (cards degrade with hints): ${missing.map(plain).join(", ")}`);
  await openCard(chatId, lines.join("\n"), buildCapabilitiesKeyboard());
}

async function openFeedbackListCard(chatId: number, sessionId: string): Promise<void> {
  const items = await listFeedback(requireCtx(), sessionId);
  const lines = [`\u{1F4CB} Feedback \u00B7 ${plain(truncate(sessionId, 24))} (${items.length})`, ""];
  for (const item of items.slice(0, 20)) {
    lines.push(`\u2022 ${item.rating === "positive" ? "\u{1F44D}" : "\u{1F44E}"} [${item.messageId.slice(0, 8)}]${item.note ? ` ${plain(truncate(item.note, 40))}` : ""}`);
  }
  if (items.length === 0) lines.push("(no feedback yet \u2014 tap \u{1F44D}/\u{1F44E} under an assistant reply)");
  await openCard(chatId, lines.join("\n"), buildSessionsKeyboard([]));
}

async function openModeCard(chatId: number): Promise<void> {
  const mode = modeSummary();
  const displayName = state.config.mode?.name;
  const lines = [
    `\u{1F3AD} Mode${displayName ? ` \u00B7 ${plain(displayName)}` : ""}`,
    "",
    plain(mode.note),
    `Profiles: ${mode.profiles.length > 0 ? mode.profiles.map(plain).join(", ") : "none found"}`,
  ];
  lines.push("", "Switch profile by restarting dsh with `dsh --profile <name>`.");
  await openCard(chatId, lines.join("\n"), buildBackKeyboard());
}

async function openAllowedCard(chatId: number): Promise<void> {
  const allowed = state.config.security.allowedChatIds;
  const lines = [`\u{1F510} Allowed chats (${allowed.length})`, ""];
  for (const id of allowed) lines.push(`\u2022 ${plain(String(id))}`);
  if (allowed.length === 0) lines.push("Nobody is allowed yet \u2014 inbound messages are ignored.");
  await openCard(chatId, lines.join("\n"), {
    inline_keyboard: [
      [{ text: "\u2795 Allow this chat", callback_data: "m:allowthis" }],
      [{ text: "\u2190 Back", callback_data: "m:back" }],
    ],
  });
}

async function openWatchCard(chatId: number): Promise<void> {
  const lines = [`\u{1F4E1} Watch`, "", state.watching ? "Telegram polling is ON." : "Telegram polling is OFF.", `autoStart: ${state.config.watch.autoStart}`];
  await openCard(chatId, lines.join("\n"), {
    inline_keyboard: [
      [{ text: state.watching ? "\u23F8 Pause polling" : "\u25B6 Start polling", callback_data: "m:watchtoggle" }],
      [{ text: "\u2190 Back", callback_data: "m:back" }],
    ],
  });
}

async function openSettingsCard(chatId: number): Promise<void> {
  const c = state.config.outbound;
  const lines = [
    "\u2699\uFE0F Telegram settings",
    "",
    `parseMode: ${c.parseMode}`,
    `disableNotification: ${c.disableNotification}`,
    `maxRetries: ${c.maxRetries} \u00B7 sendRatePerSecond: ${c.sendRatePerSecond}`,
    `maxMessageLength: ${c.maxMessageLength}`,
    "",
    "Edit .pi/telegram.json in the workspace to change these values.",
    "",
    "Host settings live under /hostsettings; credentials under /credentials.",
  ];
  await openCard(chatId, lines.join("\n"), {
    inline_keyboard: [[{ text: "\u2190 Back", callback_data: "m:back" }]],
  });
}

async function openAboutCard(chatId: number): Promise<void> {
  const bot = state.transport ? await state.transport.botInfo().catch(() => undefined) : undefined;
  const lines = [
    "\u2139\uFE0F dsh-telegram",
    "",
    `version: ${version}`,
    `bot: ${bot ? `@${plain(bot.username)} (${bot.id})` : "not connected"}`,
    `token: ${resolveToken() ? "set" : "missing"}`,
    `workspace: ${plain(state.workspaceRoot)}`,
  ];
  await openCard(chatId, lines.join("\n"), {
    inline_keyboard: [[{ text: "\u2190 Back", callback_data: "m:back" }]],
  });
}

// ---------------------------------------------------------------------------
// Callback dispatch
// ---------------------------------------------------------------------------

async function dispatchToken(chatId: number, payload: Record<string, string>): Promise<void> {
  const action = payload["action"];
  const ext = extensionForCallback(action);
  if (ext) {
    const host = buildExtensionHost();
    return ext.handler(chatId, payload, host);
  }
  const agent = currentAgent();
  switch (action) {
    case "project-open": {
      const offset = Number(payload["offset"] ?? "0");
      return openProjectCard(chatId, payload["path"], Number.isFinite(offset) && offset > 0 ? offset : 0);
    }
    case "project-up":
      return openProjectCard(chatId, parentOf(payload["path"] ?? state.workspaceRoot));
    case "project-select":
      return applyProjectPath(chatId, payload["path"] ?? state.workspaceRoot);
    case "model-select": {
      const provider = payload["provider"] ?? "";
      const model = payload["model"] ?? "";
      if (!agent) {
        // Web semantics: a session must exist for a model to attach to.
        // Auto-create one with the chosen model (same path as `✨ New`)
        // instead of failing the tap, and persist the choice as the
        // bridge's default so future sessions inherit it.
        const { result: res, agentId } = await sessionLifecycle.create(requireCtx(), state.workspaceRoot, { provider, model });
        if (agentId !== undefined) state.bridge?.setCurrentAgent(agentId);
        if (res.ok) {
          state.config.model = { provider, model };
          writeConfig(state.configRoot, state.config);
        }
        log(`model-select (no agent) provider=${provider} model=${model} -> ${res.ok ? "ok" : res.text}`);
        await requireTransport().sendText(chatId, res.ok ? `\u2728 ${plain(res.text)} \u00B7 model ${plain(provider)}/${plain(model)}` : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        refreshAllPanels();
        scheduleBarSync(chatId, 0);
        return openModelsCard(chatId);
      }
      const res = await selectSessionModel(requireCtx(), agent.id, provider, model);
      log(`model-select agent=${agent.id} provider=${provider} model=${model} -> ${res.ok ? "ok" : res.text}`);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      refreshAllPanels();
      return openModelsCard(chatId);
    }
    case "goal": {
      if (!agent) return openGoalsCard(chatId);
      const op = payload["op"] ?? "";
      const goal = getGoal(requireCtx(), agent.id);
      const t = requireTransport();
      if (op === "create") {
        await t.sendText(chatId, "/goalcreate <objective> [maxRounds]", { parse_mode: "HTML" });
      } else if (!goal) {
        await t.sendText(chatId, "\u274C No current goal.", { parse_mode: "HTML" });
      } else {
        let res;
        if (op === "pause") res = await pauseGoal(requireCtx(), agent.id, goal.id, goal.revision);
        else if (op === "resume") res = await resumeGoal(requireCtx(), agent.id, goal.id, goal.revision);
        else if (op === "complete") res = await completeGoal(requireCtx(), agent.id, goal.id, goal.revision);
        else if (op === "clear") res = await clearGoal(requireCtx(), agent.id, goal.id, goal.revision);
        else if (op === "edit") {
          await t.sendText(chatId, "/goaledit <new objective>", { parse_mode: "HTML" });
          return;
        }
        if (res) await t.sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      }
      return openGoalsCard(chatId);
    }
    case "subagent":
      return openSubagentDetailCard(chatId, payload["parentId"] ?? "", payload["childId"] ?? "");
    case "subagent-prompt": {
      const t = requireTransport();
      await t.sendText(chatId, "Reply with the prompt text:", { parse_mode: "HTML" });
      pendingSubagentPrompt = { chatId, parentId: payload["parentId"] ?? "", childId: payload["childId"] ?? "" };
      return;
    }
    case "subagent-interrupt": {
      const res = interruptSubagent(requireCtx(), payload["parentId"] ?? "", payload["childId"] ?? "");
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSubagentsCard(chatId);
    }
    case "subagent-history": {
      const items = await subagentHistory(requireCtx(), payload["childId"] ?? "", 15);
      const lines = [`\u{1F4DC} ${plain(truncate(payload["childId"] ?? "", 24))}`, ""];
      for (const item of items) lines.push(`[${item.seq}] ${item.role} ${plain(truncate(item.text, 100))}`);
      await openCard(chatId, lines.join("\n"), buildBackKeyboard());
      return;
    }
    case "preset":
      return openPresetDetailCard(chatId, payload["presetId"] ?? "");
    case "preset-select": {
      const sessionId = payload["sessionId"] ?? "";
      if (!sessionId) {
        await requireTransport().sendText(chatId, "\u274C No live session \u2014 presets select onto a session.", { parse_mode: "HTML" });
        return openPresetsCard(chatId);
      }
      const presetId = payload["presetId"] ?? "";
      if (!sessionHasStarted(requireCtx(), sessionId)) {
        const res = await selectAgentPreset(requireCtx(), sessionId, presetId);
        await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        return openPresetsCard(chatId);
      }
      // Mid-session switch: fork through the last completed turn, apply the
      // preset on the fork, then close the original session and re-bind the
      // chat to the fork.
      const res = await switchAgentPresetMidSession(requireCtx(), sessionId, presetId);
      if (res.ok && res.childId !== undefined) {
        if (res.handle !== undefined) sessionLifecycle.adopt(res.handle as never);
        state.bridge?.setCurrentAgent(res.childId);
        const closed = await sessionLifecycle.close(sessionId);
        const text = `${plain(res.text)} \u00B7 ${closed.ok ? plain(closed.text) : `\u26A0\uFE0F ${plain(closed.text)}`}`;
        await requireTransport().sendText(chatId, text, { parse_mode: "HTML" });
        refreshAllPanels();
        scheduleBarSync(chatId, 0);
      } else {
        await requireTransport().sendText(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      }
      return openPresetsCard(chatId);
    }
    case "preset-default": {
      const res = await setDefaultAgentPreset(requireCtx(), payload["presetId"] ?? "");
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openPresetsCard(chatId);
    }
    case "session-delete-confirm": {
      const sessionId = payload["sessionId"] ?? "";
      const res = await deleteSession(requireCtx(), sessionId);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSessionsCard(chatId);
    }
    case "session-delete-cancel": {
      await requireTransport().sendText(chatId, "\u2716 Delete cancelled.", { parse_mode: "HTML" });
      return;
    }
    case "preset-read": {
      const res = await readAgentPreset(requireCtx(), payload["presetId"] ?? "");
      const t = requireTransport();
      if (res.ok) {
        await t.sendText(chatId, plain((res.content ?? "").slice(0, 3800)) || "(empty composition)", { parse_mode: "HTML" });
      } else {
        await t.sendText(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      }
      return;
    }
    case "preset-copy": {
      const res = await copyAgentPreset(requireCtx(), payload["presetId"] ?? "", `${payload["presetId"] ?? "preset"}-copy`);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openPresetsCard(chatId);
    }
    case "preset-remove": {
      const res = await removeAgentPreset(requireCtx(), payload["presetId"] ?? "");
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openPresetsCard(chatId);
    }
    case "preset-open": {
      const res = openAgentPresetDocument(requireCtx(), payload["presetId"] ?? "");
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    case "feedback": {
      const sessionId = payload["sessionId"] ?? "";
      const messageId = payload["messageId"] ?? "";
      const rating = payload["rating"] === "positive" ? "positive" : "negative";
      const res = await putFeedback(requireCtx(), sessionId, messageId, rating);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    case "feedback-list":
      return openFeedbackListCard(chatId, payload["sessionId"] ?? "");
    default:
      return;
  }
}

let pendingSubagentPrompt: { chatId: number; parentId: string; childId: string } | undefined;
let pendingSteer: { chatId: number; sessionId: string } | undefined;
let pendingDelete: { chatId: number; sessionId: string } | undefined;

async function dispatchCallback(chatId: number, data: string): Promise<void> {
  const ext = extensionForCallback(data);
  if (ext) {
    const host = buildExtensionHost();
    return ext.handler(chatId, {}, host);
  }
  if (data.startsWith("t:")) {
    const payload = tokens.get(Number(data.slice(2)));
    if (payload) {
      log(`token dispatch ${data} action=${payload["action"] ?? "-"}`);
      return dispatchToken(chatId, payload);
    }
    log(`token miss ${data} (bot restarted since the card rendered)`);
    await requireTransport().sendText(chatId, "\u26A0\uFE0F That button was from an older card (bot restarted). Reopen the card and tap again.", { parse_mode: "HTML" });
    return;
  }
  if (data.startsWith("ap:")) {
    const [, idText, answer] = data.split(":");
    const outcome = answer === "y" ? "allowed-once" : "rejected";
    const accepted = state.interactive?.answerApproval(Number(idText), outcome);
    if (!accepted) await requireTransport().sendText(chatId, "\u274C That approval is already settled.", { parse_mode: "HTML" });
    return;
  }
  if (data.startsWith("qu:")) {
    const parts = data.split(":");
    const id = Number(parts[1]);
    if (parts[2] === "s") {
      await state.interactive?.submitQuestions(chatId, id);
    } else if (parts[2] === "c") {
      await state.interactive?.cancelQuestions(chatId, id);
    } else {
      const questionIndex = Number(parts[2]);
      const optionId = parts.slice(3).join(":");
      const questionId = questionIdAt(id, questionIndex);
      if (questionId !== undefined) await state.interactive?.toggleQuestionOption(chatId, id, questionId, optionId);
    }
    return;
  }
  if (data.startsWith("s:")) {
    const [, id, sub] = data.split(":");
    if (sub === "use") {
      const agent = sessionLifecycle.find(requireCtx(), id) ?? (await resumeSession(requireCtx(), id).then((res) => (res.ok && res.agentId !== undefined ? sessionLifecycle.find(requireCtx(), res.agentId) : undefined)).catch(() => undefined));
      if (!agent) {
        await requireTransport().sendText(chatId, `\u274C Session ${plain(truncate(id, 32))} is not live.`, { parse_mode: "HTML" });
      } else {
        state.bridge?.setCurrentAgent(id);
        await requireTransport().sendText(chatId, `\u{1F3AF} Switched to session ${plain(truncate(id, 32))}.`, { parse_mode: "HTML" });
      }
      return openSessionsCard(chatId);
    }
    if (sub === "history") return openHistoryCard(chatId, id);
    if (sub === "rename") {
      const t = requireTransport();
      await t.sendText(chatId, `/rename <title> \u2014 reply with just the title to rename ${plain(truncate(id, 24))}:`, { parse_mode: "HTML" });
      pendingRename = { chatId, sessionId: id };
      return;
    }
    if (sub === "fork") {
      const res = forkSession(requireCtx(), id);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSessionsCard(chatId);
    }
    if (sub === "archive") {
      const res = await archiveSession(requireCtx(), id);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSessionsCard(chatId);
    }
    if (sub === "model") return openProviderModelsCard(chatId, currentSessionModel(requireCtx(), id).provider ?? "deepseek");
    if (sub === "stop") {
      const res = sessionLifecycle.stop(requireCtx(), id);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openSessionDetailCard(chatId, id);
    }
    if (sub === "delete") {
      const confirm = token({ action: "session-delete-confirm", sessionId: id });
      const cancel = token({ action: "session-delete-cancel", sessionId: id });
      await requireTransport().sendText(chatId, `\u{1F5D1} Delete ${plain(truncate(id, 24))}?`, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "\u2705 Confirm", callback_data: confirm }, { text: "\u2716 Cancel", callback_data: cancel }]],
        },
      });
      return;
    }
    if (sub === "steer") {
      pendingSteer = { chatId, sessionId: id };
      await requireTransport().sendText(chatId, `\u{1F3AF} Steer ${plain(truncate(id, 24))} \u2014 send the steer text:`, { parse_mode: "HTML" });
      return;
    }
    if (sub === "log") {
      const exported = await exportSessionLog(requireCtx(), id, false).catch(() => ({ result: { ok: false, text: "session log export failed" }, buffer: undefined }));
      if (exported.result.ok && exported.buffer !== undefined) {
        const fileId = await requireTransport().sendDocument(chatId, exported.buffer, `session-${id.slice(0, 16)}.zip`, `\u{1F4E6} Session log \u00B7 ${plain(truncate(id, 24))}`);
        if (fileId === undefined) await requireTransport().sendText(chatId, "\u274C Log sent but the document upload was not confirmed.", { parse_mode: "HTML" });
      } else {
        await requireTransport().sendText(chatId, `\u274C ${plain(exported.result.text)}`, { parse_mode: "HTML" });
      }
      return;
    }
    if (sub === "queue") {
      const agent = sessionLifecycle.find(requireCtx(), id);
      if (!agent) {
        await requireTransport().sendText(chatId, "\u274C Session is not live \u2014 the queue is agent-owned.", { parse_mode: "HTML" });
        return openSessionsCard(chatId);
      }
      const items = listQueue(requireCtx(), id);
      await openCard(chatId, `\u231B Queue \u00B7 ${plain(truncate(id, 24))} (${items.length})`, buildQueueKeyboard(items.map((item) => ({ itemId: item.itemId, kind: item.target }))));
      return;
    }
    return openSessionDetailCard(chatId, id);
  }
  if (data.startsWith("w:")) {
    const [, id, sub] = data.split(":");
    if (sub === "create") {
      await requireTransport().sendText(chatId, "/workspacecreate <path> [title]", { parse_mode: "HTML" });
      return;
    }
    if (sub === "rename") {
      await requireTransport().sendText(chatId, `/workspacerename ${id} <title>`, { parse_mode: "HTML" });
      return;
    }
    if (sub === "delete") {
      const res = await deleteWorkspace(requireCtx(), id);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openWorkspacesCard(chatId);
    }
    if (sub === "up" || sub === "down") {
      const { items } = listWorkspaces(requireCtx());
      const index = items.findIndex((workspace) => workspace.workspaceId === id);
      if (index !== -1) {
        const anchor = sub === "up" ? items[index - 1]?.workspaceId : items[index + 2]?.workspaceId;
        const res = await insertWorkspaceBefore(requireCtx(), id, anchor);
        await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      }
      return openWorkspacesCard(chatId);
    }
    if (sub === "pin") {
      await requireTransport().sendText(chatId, "/workspacepin <workspaceId> <sessionId> [beforeSessionId]", { parse_mode: "HTML" });
      return;
    }
    return openWorkspaceDetailCard(chatId, id);
  }
  if (data.startsWith("q:")) {
    const parts = data.split(":");
    const itemId = parts[1] ?? "";
    const kind = parts[2] ?? "";
    const agent = currentAgent();
    if (!agent) {
      await requireTransport().sendText(chatId, "\u274C No live agent owns the queue.", { parse_mode: "HTML" });
      return openQueueCard(chatId);
    }
    let res;
    if (kind === "e") {
      pendingQueueEdit = { chatId, itemId };
      await requireTransport().sendText(chatId, `\u270F Edit queued item ${itemId.slice(0, 8)} \u2014 send the new text now (or /cancel).`, { parse_mode: "HTML" });
      return;
    }
    if (kind === "r") res = updateQueueItem(requireCtx(), agent.id, itemId, { kind: "remove" });
    else if (kind === "s") res = updateQueueItem(requireCtx(), agent.id, itemId, { kind: "steer" });
    else {
      await requireTransport().sendText(chatId, `/queueedit <itemId> <text>`, { parse_mode: "HTML" });
      return;
    }
    await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
    refreshAllPanels();
    scheduleBarSync(chatId, 0);
    return openQueueCard(chatId);
  }
  if (data.startsWith("mo:")) {
    return openProviderModelsCard(chatId, decodeURIComponent(data.slice(3)));
  }
  if (data.startsWith("set:")) {
    return openSettingsNamespaceCard(chatId, decodeURIComponent(data.slice(4)));
  }
  if (data.startsWith("h:")) {
    const sub = data.slice(2);
    if (sub === "ls") {
      const res = await listDirectory(state.workspaceRoot);
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    if (sub === "mkdir") {
      await requireTransport().sendText(chatId, "/mkdir <path>", { parse_mode: "HTML" });
      return;
    }
    return;
  }
  const match = CALLBACK_RE.exec(data);
  if (!match) return;
  const action = match[1]!;
  const payload = match[2] !== undefined ? decodeURIComponent(match[2]) : undefined;
  switch (action) {
    case "close":
      await ephemeral.clear(chatId, requireTransport());
      return;
    case "back":
      return openMenuAt(chatId, 0);
    case "more":
      return openMenuAt(chatId, (menuPageIndex.get(chatId) ?? 0) + 1);
    case "prev":
      return openMenuAt(chatId, (menuPageIndex.get(chatId) ?? 0) - 1);
    case "page":
      return;
    case "stop": {
      const res = sessionLifecycle.stop(requireCtx(), state.bridge?.currentAgentIdValue());
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return openMenuAt(chatId, menuPageIndex.get(chatId) ?? 0);
    }
    case "project":
      return openProjectCard(chatId);
    case "models":
      return openModelsCard(chatId);
    case "plugins":
      return openPluginsCard(chatId);
    case "sessions":
      return openSessionsCard(chatId);

    case "use": {
      const id = payload ?? "";
      if (id === "" || !sessionLifecycle.find(requireCtx(), id)) {
        await requireTransport().sendText(chatId, `\u274C Session ${plain(truncate(id, 32))} is not live.`, { parse_mode: "HTML" });
        return;
      }
      state.bridge?.setCurrentAgent(id);
      await requireTransport().sendText(chatId, `\u{1F3AF} Switched to session ${plain(truncate(id, 32))}.`, { parse_mode: "HTML" });
      return openSessionsCard(chatId);
    }
    case "mode":
      return openModeCard(chatId);
    case "queue":
      return openQueueCard(chatId);
    case "allowed":
      return openAllowedCard(chatId);
    case "watch":
      return openWatchCard(chatId);
    case "settings":
      return openSettingsCard(chatId);
    case "about":
      return openAboutCard(chatId);
    case "status":
      await ephemeral.open(chatId, requireTransport());
      await statusPanel.refresh(chatId, requireTransport(), renderStatus(), true);
      return;
    case "new": {
      const { result: res, agentId } = await sessionLifecycle.create(requireCtx(), state.workspaceRoot, state.config.model);
      if (agentId !== undefined) state.bridge?.setCurrentAgent(agentId);
      await sendWithLiveBar(chatId, res.ok ? `\u2728 ${plain(res.text)}` : `\u274C ${plain(res.text)}`);
      return;
    }
    case "compact": {
      const res = await compactCurrent(requireCtx(), state.bridge?.currentAgentIdValue());
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    case "allowthis": {
      if (!isChatAllowed(state.config, chatId)) {
        state.config.security.allowedChatIds.push(chatId);
        writeConfig(state.configRoot, state.config);
      }
      return openAllowedCard(chatId);
    }
    case "watchtoggle":
      if (state.watching) await stopWatching();
      else await startWatching();
      return openWatchCard(chatId);
    case "workspaces":
      return openWorkspacesCard(chatId);
    case "project":
      return openProjectCard(chatId);
    case "goals":
      return openGoalsCard(chatId);
    case "skills":
      return openSkillsCard(chatId);
    case "subagents":
      return openSubagentsCard(chatId);
    case "presets":
      return openPresetsCard(chatId);
    case "hostsettings":
      return openHostSettingsCard(chatId);
    case "credentials":
      return openCredentialsCard(chatId);
    case "host":
      return openHostCard(chatId);
    case "jobs":
      return openJobsCard(chatId);
    case "dynamic":
      return openDynamicCordisCard(chatId);
    case "capabilities":
      return openCapabilitiesCard(chatId);
    case "discover":
      await requireTransport().sendText(chatId, "/discover <settingsNs> [baseURL]", { parse_mode: "HTML" });
      return;
    case "cred-describe":
      await requireTransport().sendText(chatId, "/credential <REF>", { parse_mode: "HTML" });
      return;
    default:
      return;
  }
}

let pendingRename: { chatId: number; sessionId: string } | undefined;
let pendingQueueEdit: { chatId: number; itemId: string } | undefined;

// ---------------------------------------------------------------------------
// Bar + command dispatch
// ---------------------------------------------------------------------------

async function dispatchBarButton(chatId: number, label: string): Promise<void> {
  log(`bar button ${label}`);
  const ext = extensionForBar(label);
  if (ext) {
    const host = buildExtensionHost();
    return ext.handler(chatId, host);
  }
  switch (label) {
    case MENU_BTN:
      return openMenuAt(chatId, 0);
    case NEW_BTN: {
      const { result: res, agentId } = await sessionLifecycle.create(requireCtx(), state.workspaceRoot, state.config.model);
      if (agentId !== undefined) state.bridge?.setCurrentAgent(agentId);
      await sendWithLiveBar(chatId, res.ok ? `\u2728 ${plain(res.text)}` : `\u274C ${plain(res.text)}`);
      return;
    }
    case COMPACT_BTN: {
      const res = await compactCurrent(requireCtx(), state.bridge?.currentAgentIdValue());
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    case MODELS_BTN:
      return openModelsCard(chatId);
    case PLUGINS_BTN:
      return openPluginsCard(chatId);
    case MODE_BTN:
      return openModeCard(chatId);
    case SESSIONS_BTN:
      return openSessionsCard(chatId);
    case STATUS_BTN:
      await ephemeral.open(chatId, requireTransport());
      await statusPanel.refresh(chatId, requireTransport(), renderStatus(), true);
      return;
    case QUEUE_BTN:
      return openQueueCard(chatId);
    case PRESETS_BTN:
      return openPresetsCard(chatId);
    case THINKING_BTN:
      return dispatchBarButton(chatId, REASONING_BTN);
    case STOP_BTN: {
      const res = sessionLifecycle.stop(requireCtx(), state.bridge?.currentAgentIdValue());
      await requireTransport().sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
      return;
    }
    default:
      return;
  }
}

async function dispatchCommand(chatId: number, command: string, args: string): Promise<void> {
  const ext = extensionForCommand(command);
  if (ext) {
    const host = buildExtensionHost();
    return ext.handler(chatId, args, host);
  }
  const t = state.transport;
  if (!t) return;
  const ctx = requireCtx();
  const agent = currentAgent();
  const send = (text: string, okResult = true) => t.sendText(chatId, okResult ? plain(text) : `\u274C ${plain(text)}`, { parse_mode: "HTML" });
  switch (command) {
    case "start":
      state.chats.add(chatId);
      await t.setCommands([
        { command: "start", description: "Welcome + bar" },
        { command: "menu", description: "Core menu card" },
        { command: "new", description: "Fresh session in the workspace" },
        { command: "compact", description: "Compact the current session" },
        { command: "models", description: "Browse providers and models" },
        { command: "status", description: "Live status card" },
        { command: "stop", description: "Cancel the current turn" },
        { command: "sessions", description: "Sessions list" },
        { command: "workspaces", description: "Workspaces list" },
        { command: "goals", description: "Current goal" },
        { command: "plugins", description: "Plugin inventory" },
        { command: "config", description: "Get/set bridge config live" },
        { command: "help", description: "All commands" },
      ]);
      await sendWithLiveBar(chatId, `\u{1F916} dsh-telegram ${version} ready. Send a message to talk to the agent; the bar below carries all functions.`, {
        parse_mode: "HTML",
      });
      return;
    case "help":
      await send(
        [
          "Commands:",
          "/new /compact /stop /models /sessions /workspaces /project [path] /goals /skills /subagents /presets /plugins /hostsettings /credentials /host /jobs /status /menu",
          "/history [sessionId] [limit] \u00B7 /search <query> \u00B7 /rename <title> \u00B7 /fork [atSeq] \u00B7 /use <sessionId> \u00B7 /archive <sessionId>",
          "/queue \u00B7 /queueedit <itemId> <text> \u00B7 /steer <text> \u00B7 /cancel",
          "/goalcreate <objective> [maxRounds] \u00B7 /goaledit <text>",
          "/workspacecreate <path> [title] \u00B7 /workspacepin <workspaceId> <sessionId> [beforeSessionId]",
          "/pluginenable <name> \u00B7 /plugindisable <name> \u00B7 /settingsdescribe [ns] \u00B7 /settingsupdate <ns> <json>",
          "/credential <REF> \u00B7 /credentialset <REF> <value> \u00B7 /credentialunset <REF>",
          "/ls [path] \u00B7 /mkdir <path> \u00B7 /discover <settingsNs> [baseURL] \u00B7 /subagentprompt <text>",
          "/sessionlog [sessionId] \u00B7 /commands \u00B7 /capabilities \u00B7 /config get|set <path> [json]",
          "/menucheck \u00B7 self-checks every menu card's data source",
        ].join("\n"),
      );
      return;
    case "menu":
      return openMenuAt(chatId, 0);
    case "cancel": {
      if (pendingQueueEdit && pendingQueueEdit.chatId === chatId) {
        pendingQueueEdit = undefined;
        await send("Queue edit cancelled.");
      } else {
        await send("Nothing to cancel.");
      }
      return;
    }
    case "new": {
      const { result: res, agentId } = await sessionLifecycle.create(ctx, state.workspaceRoot);
      if (agentId !== undefined) state.bridge?.setCurrentAgent(agentId);
      await send(res.text, res.ok);
      return;
    }
    case "compact": {
      const res = await compactCurrent(ctx, state.bridge?.currentAgentIdValue());
      await send(res.text, res.ok);
      return;
    }
    case "models":
      return openModelsCard(chatId);
    case "status":
      await ephemeral.open(chatId, t);
      await statusPanel.refresh(chatId, t, renderStatus(), true);
      return;
    case "stop": {
      const res = sessionLifecycle.stop(ctx, state.bridge?.currentAgentIdValue());
      await send(res.text, res.ok);
      return;
    }
    case "sessions":
      return openSessionsCard(chatId);
    case "workspaces":
      return openWorkspacesCard(chatId);
    case "project":
      if (args.trim() !== "") return applyProjectPath(chatId, args.trim());
      return openProjectCard(chatId);
    case "goals":
      return openGoalsCard(chatId);
    case "skills":
      return openSkillsCard(chatId);
    case "subagents":
      return openSubagentsCard(chatId);
    case "presets":
      return openPresetsCard(chatId);
    case "plugins":
      return openPluginsCard(chatId);
    case "hostsettings":
      return openHostSettingsCard(chatId);
    case "credentials":
      return openCredentialsCard(chatId);
    case "host":
      return openHostCard(chatId);
    case "jobs":
      return openJobsCard(chatId);
    case "capabilities":
      return openCapabilitiesCard(chatId);
    case "menucheck": {
      const checkCtx = requireCtx();
      const checkAgent = currentAgent();
      const checks: [string, () => unknown | Promise<unknown>][] = [
        ["status", () => statusSnapshot(checkCtx)],
        ["models", () => modelCatalog(checkCtx, {})],
        ["plugins", () => listPlugins(checkCtx)],
        ["sessions", () => listSessionDetails(checkCtx)],
        ["history", () => readHistory(checkCtx, checkAgent?.id ?? "", 1)],
        ["queue", () => (checkAgent ? listQueue(checkCtx, checkAgent.id) : [])],
        ["workspaces", () => listWorkspaces(checkCtx)],
        ["goals", () => getGoal(checkCtx, checkAgent?.id ?? "")],
        ["skills", () => listSkills(checkCtx)],
        ["subagents", () => listSubagents(checkCtx, checkAgent?.id ?? "")],
        ["presets", () => listAgentPresets(checkCtx)],
        ["settings", () => describeSettings(checkCtx)],
        ["credentials", () => describeCredential(checkCtx, "")],
        ["host", () => describeHost(checkCtx)],
        ["jobs", () => listJobs(checkCtx, checkAgent?.id)],
        ["dynamic", () => listDynamicCordis(checkCtx)],
        ["capabilities", () => probeCapabilities(checkCtx)],
        ["mode", () => modeSummary()],
      ];
      const lines = ["\u{1FA7A} Menu self-check", ""];
      let failures = 0;
      for (const [label, fn] of checks) {
        try {
          await fn();
          lines.push(`\u2705 ${label}`);
        } catch (err) {
          failures += 1;
          lines.push(`\u274C ${label} \u2014 ${plain(truncate(err instanceof Error ? err.message : String(err), 60))}`);
        }
      }
      lines.push("", failures === 0 ? "All menu data sources are healthy." : `${failures} check(s) failed.`);
      await openCard(chatId, lines.join("\n"), buildBackKeyboard());
      return;
    }
    case "config": {
      const [op, path, ...rest] = args.trim().split(/\s+/);
      if (!op || !path) {
        await send("/config get <path> \u00B7 /config set <path> <json> \u2014 hot-applies + persists under .pi/telegram.json");
        return;
      }
      try {
        if (op === "get") {
          await send(`${path} = ${JSON.stringify(getConfigPath(state.config, path))}`);
          return;
        }
        if (op === "set") {
          const value = JSON.parse(rest.join(" "));
          const { config, changed } = overlayConfig(state.config, patchFromPath(path, value));
          if (changed.length === 0) {
            await send(`Unknown config path ${path}.`, false);
            return;
          }
          state.config = config;
          applyConfigLive(changed);
          writeConfig(state.configRoot, state.config);
          await send(`\u2705 ${path} \u2192 applied live + persisted (${changed.join(", ")})`);
          return;
        }
      } catch (err) {
        await send(err instanceof Error ? err.message : String(err), false);
        return;
      }
      await send("Usage: /config get <path> \u00B7 /config set <path> <json>", false);
      return;
    }
    case "history": {
      const [id, limitText] = args.trim().split(/\s+/);
      const sessionId = id || boundAgentId();
      if (!sessionId) {
        await send("No session id given and none bound.");
        return;
      }
      const items = await readHistory(ctx, sessionId, Number(limitText) || 20);
      const lines = [`\u{1F4DC} ${plain(truncate(sessionId, 24))}`, ""];
      for (const item of items) lines.push(`[${item.seq}] ${item.role} ${plain(truncate(item.text, 120))}`);
      await send(lines.join("\n"));
      return;
    }
    case "search": {
      const query = args.trim();
      if (!query) {
        await send("usage: /search <query>");
        return;
      }
      const hits = await searchSessions(ctx, query, 20);
      const lines = [`\u{1F50D} ${plain(query)} \u2014 ${hits.length} hit(s)`, ""];
      for (const hit of hits.slice(0, 10)) lines.push(`\u2022 ${plain(truncate(hit.sessionId, 24))} [${hit.seq}] \u2026${plain(truncate(hit.snippet, 60))}`);
      await send(lines.join("\n"));
      return;
    }
    case "rename": {
      const title = args.trim();
      const sessionId = boundAgentId();
      if (!sessionId) {
        await send("No bound session \u2014 use the Sessions card.");
        return;
      }
      if (!title) {
        pendingRename = { chatId, sessionId };
        await send(`Reply with just the title to rename ${plain(truncate(sessionId, 24))}:`);
        return;
      }
      const res = renameSession(ctx, sessionId, title);
      await send(res.text, res.ok);
      return;
    }
    case "fork": {
      const sessionId = boundAgentId();
      if (!sessionId) {
        await send("No bound session \u2014 use the Sessions card.");
        return;
      }
      const atSeq = args.trim() ? Number(args.trim()) : undefined;
      const res = forkSession(ctx, sessionId, Number.isFinite(atSeq) ? atSeq : undefined);
      await send(res.text, res.ok);
      return;
    }
    case "use": {
      const id = args.trim();
      if (!id) {
        await send("usage: /use <sessionId>");
        return;
      }
      const live = sessionLifecycle.find(ctx, id);
      if (live) {
        state.bridge?.setCurrentAgent(id);
        await send(`\u{1F3AF} Switched to ${plain(truncate(id, 24))}.`);
      } else {
        const res = await resumeSession(ctx, id);
        if (res.ok && res.agentId !== undefined) {
          state.bridge?.setCurrentAgent(res.agentId);
          await send(res.text, true);
        } else {
          await send(res.text, false);
        }
      }
      return;
    }
    case "archive": {
      const res = await archiveSession(ctx, args.trim() || boundAgentId() || "");
      await send(res.text, res.ok);
      return;
    }
    case "steer": {
      const text = args.trim();
      const sessionId = boundAgentId();
      if (!sessionId || !text) {
        await send("usage: /steer <text> (needs a bound session)");
        return;
      }
      const res = promptSession(ctx, sessionId, text, "steer");
      await send(res.text, res.ok);
      return;
    }
    case "queue":
      return openQueueCard(chatId);
    case "queueedit": {
      const [itemId, ...rest] = args.trim().split(/\s+/);
      const text = rest.join(" ");
      const sessionId = boundAgentId();
      if (!sessionId || !itemId || !text) {
        await send("usage: /queueedit <itemId> <text>");
        return;
      }
      const res = updateQueueItem(ctx, sessionId, itemId, { kind: "edit", content: text });
      await send(res.text, res.ok);
      return;
    }
    case "goalcreate": {
      const parts = args.trim().split(/\s+/);
      const maxRounds = parts.length > 1 ? Number(parts[parts.length - 1]) : undefined;
      const objective = Number.isFinite(maxRounds) ? parts.slice(0, -1).join(" ") : parts.join(" ");
      if (!agent) {
        await send("No live agent \u2014 goals are per-agent.");
        return;
      }
      const res = await createGoal(ctx, agent.id, objective, Number.isFinite(maxRounds) ? maxRounds : undefined);
      await send(res.text, res.ok);
      return;
    }
    case "goaledit": {
      const text = args.trim();
      const goal = agent ? getGoal(ctx, agent.id) : undefined;
      if (!agent || !goal || !text) {
        await send("usage: /goaledit <text> (needs a current goal)");
        return;
      }
      const res = await editGoal(ctx, agent.id, goal.id, goal.revision, { objective: text });
      await send(res.text, res.ok);
      return;
    }
    case "workspacecreate": {
      const parts = args.trim().split(/\s+/);
      const path = parts[0] ?? "";
      const title = parts.slice(1).join(" ");
      const res = await createWorkspace(ctx, path, title || undefined);
      await send(res.text, res.ok);
      return;
    }
    case "workspacerename": {
      const [id, ...rest] = args.trim().split(/\s+/);
      const res = await renameWorkspace(ctx, id ?? "", rest.join(" "));
      await send(res.text, res.ok);
      return;
    }
    case "workspacepin": {
      const [workspaceId, sessionId, beforeSessionId] = args.trim().split(/\s+/);
      const res = await insertSessionBefore(ctx, workspaceId ?? "", sessionId ?? "", beforeSessionId || undefined);
      await send(res.text, res.ok);
      return;
    }
    case "pluginenable":
    case "plugindisable": {
      const name = args.trim();
      if (!name) {
        await send(`usage: /${command} <plugin-name>`);
        return;
      }
      const entryId = entryIdFor(ctx, name);
      if (!entryId) {
        await send(`plugin entry ${plain(name)} not found \u2014 check /plugins.`);
        return;
      }
      const res = await togglePlugin(ctx, entryId, command === "plugindisable");
      await send(res.text, res.ok);
      return;
    }
    case "settingsdescribe": {
      const ns = args.trim();
      const { writable, hasDocument, namespaces } = describeSettings(ctx);
      if (ns) {
        const view = namespaces.find((candidate) => candidate.ns === ns);
        if (!view) {
          await send(`namespace ${plain(ns)} not found`);
        } else {
          await send(`\u2699\uFE0F ${plain(ns)} \u00B7 applies ${view.applies} \u00B7 rev ${view.revision}\nvalue: ${plain(truncate(JSON.stringify(view.value), 800))}\nsecrets: ${view.secrets.map((s) => `${s.path.join(".")}=${s.set ? "set" : "unset"}`).join(", ") || "none"}`);
        }
      } else {
        await send(`writable: ${writable} \u00B7 document: ${hasDocument} \u00B7 namespaces: ${namespaces.map((n) => plain(n.ns)).join(", ") || "none"}`);
      }
      return;
    }
    case "settingsupdate": {
      const space = args.indexOf(" ");
      const ns = space === -1 ? args.trim() : args.slice(0, space);
      const raw = space === -1 ? "" : args.slice(space + 1).trim();
      if (!ns || !raw) {
        await send("usage: /settingsupdate <ns> <json patch>");
        return;
      }
      let patch: unknown;
      try {
        patch = JSON.parse(raw);
      } catch {
        await send("patch must be valid JSON");
        return;
      }
      const res = await updateSettings(ctx, ns, patch as object);
      await send(res.text, res.ok);
      return;
    }
    case "credential": {
      const res = await describeCredential(ctx, args.trim());
      await send(res.text, res.ok);
      return;
    }
    case "credentialset": {
      const space = args.indexOf(" ");
      const ref = space === -1 ? args.trim() : args.slice(0, space);
      const value = space === -1 ? "" : args.slice(space + 1);
      const res = await setCredential(ctx, ref, value);
      await send(res.text, res.ok);
      return;
    }
    case "credentialunset": {
      const res = await unsetCredential(ctx, args.trim());
      await send(res.text, res.ok);
      return;
    }
    case "ls": {
      const res = await listDirectory(args.trim() || state.workspaceRoot);
      await send(res.text, res.ok);
      return;
    }
    case "mkdir": {
      const res = await createDirectory(args.trim());
      await send(res.text, res.ok);
      return;
    }
    case "discover": {
      const [settingsNs, baseURL] = args.trim().split(/\s+/);
      if (!settingsNs) {
        await send("usage: /discover <settingsNs> [baseURL]");
        return;
      }
      const res = await discoverModels(ctx, settingsNs, baseURL ? { baseURL } : {});
      await send(res.text, res.ok);
      return;
    }
    case "subagentprompt": {
      if (!pendingSubagentPrompt || pendingSubagentPrompt.chatId !== chatId) {
        await send("Open a subagent first, then reply with the prompt text.");
        return;
      }
      const res = await promptSubagent(ctx, pendingSubagentPrompt.parentId, pendingSubagentPrompt.childId, args.trim());
      pendingSubagentPrompt = undefined;
      await send(res.text, res.ok);
      return;
    }
    case "sessionlog": {
      const sessionId = args.trim() || boundAgentId();
      if (!sessionId) {
        await send("usage: /sessionlog <sessionId>");
        return;
      }
      await send("Building the session-log ZIP (same archive the web serves)\u2026");
      const exported = await exportSessionLog(ctx, sessionId, true);
      if (exported.result.ok && exported.buffer) {
        await t.sendDocument(chatId, exported.buffer, `${sessionId}.zip`, `${sessionId} \u00B7 session log`);
        await send(exported.result.text, true);
      } else {
        await send(exported.result.text, false);
      }
      return;
    }
    case "commands": {
      if (!agent) {
        await send("No live agent \u2014 commands are agent-scoped.");
        return;
      }
      const commands = listCommands(ctx, agent);
      const lines = [`\u2328\uFE0F Commands (${commands.length})`, ""];
      for (const entry of commands) lines.push(`/${entry.name}${entry.input ? ` ${entry.input}` : ""} \u2014 ${plain(truncate(entry.description, 60))}`);
      await send(lines.join("\n"));
      return;
    }
    default: {
      if (agent) {
        const res = await executeCommand(ctx, agent, `/${command}${args ? ` ${args}` : ""}`);
        if (res.text !== "unknown or malformed slash command: /" && !res.text.includes("unknown or malformed slash command")) {
          await send(res.text, res.ok);
          return;
        }
      }
      await send(`Unknown command /${command} \u2014 try /help.`);
      return;
    }
  }
}

async function dispatchPhoto(chatId: number, fileId: string, caption: string): Promise<void> {
  const t = requireTransport();
  const ctx = requireCtx();
  const agent = currentAgent();
  if (!agent) {
    await t.sendText(chatId, "\u274C No live agent in this session.", { parse_mode: "HTML" });
    return;
  }
  const data = await t.downloadFile(fileId);
  if (!data) {
    await t.sendText(chatId, "\u274C Photo download failed.", { parse_mode: "HTML" });
    return;
  }
  const saved = await saveImageAttachment(ctx, data, "image/jpeg", `telegram-${fileId}.jpg`);
  if (!saved.ok || !saved.attachment) {
    await t.sendText(chatId, `\u274C ${plain(saved.text)}`, { parse_mode: "HTML" });
    return;
  }
  const res = state.bridge?.deliverImage(chatId, saved.attachment, caption);
  if (res && !res.ok) await t.sendText(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
  else {
    await t.sendText(chatId, res?.text ?? "Image delivered.", { parse_mode: "HTML" });
    scheduleBarSync(chatId, 0);
  }
}

// ---------------------------------------------------------------------------
// Watch + lifecycle
// ---------------------------------------------------------------------------

async function startWatching(): Promise<void> {
  if (state.watching) return;
  const t = requireTransport();
  await t.start();
  state.watching = true;
}

async function stopWatching(): Promise<void> {
  if (!state.watching) return;
  if (state.transport) await state.transport.stop();
  state.watching = false;
}

function refreshAllPanels(): void {
  if (!state.transport) return;
  for (const chatId of state.chats) {
    void statusPanel.refresh(chatId, state.transport, renderStatus());
    scheduleBarSync(chatId);
  }
}

/** Live agent inbox size — the web's `status.queue` value. */
function currentQueueCount(): number {
  try {
    return statusSnapshot(requireCtx(), boundAgentId()).queue;
  } catch {
    return 0;
  }
}

/** Remove the previous dedicated bar carrier so history never accumulates them. */
async function dropBarCarrier(chatId: number, t: TelegramTransport): Promise<void> {
  const carrier = state.barCarriers.get(chatId);
  if (carrier === undefined) return;
  state.barCarriers.delete(chatId);
  await t.deleteMessage(chatId, carrier).catch(() => {});
}

/** Send a normal message that carries the live bar (count embedded). */
async function sendWithLiveBar(chatId: number, text: string, options: Parameters<TelegramTransport["sendText"]>[2] = {}): Promise<number | undefined> {
  const t = state.transport;
  if (!t) return undefined;
  const count = currentQueueCount();
  state.barCounts.set(chatId, count);
  await dropBarCarrier(chatId, t);
  return t.sendText(chatId, text, { ...options, reply_markup: buildBarKeyboard(count) });
}

/** Telegram reply keyboards cannot be edited in place, so the live count is
 * pushed by replacing a tiny carrier message (delete + resend). Debounced
 * per chat because agent/status and turn/end fire in bursts. */
function scheduleBarSync(chatId: number, delayMs = 1500): void {
  if (!state.barCounts.has(chatId)) return;
  const existing = state.barTimers.get(chatId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.barTimers.delete(chatId);
    void syncBar(chatId).catch((err) => log("bar sync failed", err));
  }, delayMs);
  state.barTimers.set(chatId, timer);
}

/** Swap the dedicated bar carrier in place when the queue count changed. */
async function syncBar(chatId: number): Promise<void> {
  const t = state.transport;
  if (!t) return;
  const count = currentQueueCount();
  log(`bar sync chatId=${chatId} count=${count} last=${state.barCounts.get(chatId)}`);
  if (count === state.barCounts.get(chatId)) return;
  state.barCounts.set(chatId, count);
  await dropBarCarrier(chatId, t);
  const id = await t.sendText(chatId, queueBarLabel(count), {
    parse_mode: "HTML",
    disable_notification: true,
    reply_markup: buildBarKeyboard(count),
  });
  if (id !== undefined) state.barCarriers.set(chatId, id);
}

export function apply(ctx: Context, loaderConfig?: unknown): void {
  if (state.context) teardownMount();
  state.context = ctx;

  state.workspaceRoot = findWorkspaceRoot(process.cwd()) ?? process.cwd();
  state.configRoot = state.workspaceRoot;
  state.config = overlayConfig(readConfig(state.configRoot), loaderConfig).config;
  // Restore the persisted project synchronously: an async restore races the
  // first session creation and silently moves the workspace back to the
  // boot directory ("workspace drifted without any project/session change").
  if (state.config.workspace.activePath) {
    if (existsSync(state.config.workspace.activePath)) {
      state.workspaceRoot = state.config.workspace.activePath;
    }
  }

  // The provided `telegram` service is the single seam external/subpath
  // plugins read. It carries both the public bridge API and the full
  // ExtensionHost surface (streaming draft, cards, stats, agent binding) so
  // a loader-mounted plugin like dsh-telegram/extensions/openclaw needs no
  // knowledge of core internals.
  ctx.provide("telegram", {
    ...buildExtensionHost(),
    getConfig: () => ({ ...state.config }),
    status: () => renderStatus(),
    chats: () => [...state.chats],
    sendText: (chatId: number, text: string) => requireTransport().sendText(chatId, plain(text), { parse_mode: "HTML" }),
    broadcast: async (text: string) => {
      const delivered: { chatId: number; messageId: number }[] = [];
      for (const chatId of [...state.chats]) {
        const id = await state.transport?.sendText(chatId, plain(text), { parse_mode: "HTML" });
        if (id !== undefined) delivered.push({ chatId, messageId: id });
      }
      return delivered;
    },
    start: () => startWatching(),
    stop: () => stopWatching(),
    /** Harness-style extension seam: any cordis plugin (this package's
     * subpath plugins or a third party) registers its domain through here.
     * Name-keyed, so double registration (builtin + loader entry) is safe.
     * Hot plug: the UI (open menus + status panels) refreshes immediately. */
    registerExtension: (extension: TelegramExtension) => {
      if (extensions.some((existing) => existing.name === extension.name)) return;
      extensions.push(extension);
      refreshExtensionUi();
    },
    unregisterExtension: (name: string) => {
      const index = extensions.findIndex((existing) => existing.name === name);
      if (index === -1) return;
      const [removed] = extensions.splice(index, 1);
      removed.detach?.();
      refreshExtensionUi();
    },
  });

  // Built-in extensions register directly (core's own apply cannot read its
  // freshly provided service — cordis provide registers through fiber.effect).
  // Loader-driven duplicates dedupe by name inside registerExtension.
  extensions.push(reasoningExtension);

  ctx.on("internal/update", (incoming, _noSave, next) => {
    try {
      const { config, changed } = overlayConfig(state.config, incoming);
      if (changed.length === 0) return next();
      state.config = config;
      applyConfigLive(changed);
      log(`config hot-applied live: ${changed.join(", ")}`);
      return;
    } catch (err) {
      log("config hot-apply failed \u2014 falling back to the official restart path", err);
      return next();
    }
  });

  const token = resolveToken();
  if (token) {
    state.transport = new TelegramTransport({
      token,
      log,
      queue: new SendQueue({
        maxPerWindow: state.config.outbound.sendRatePerSecond,
        retry: { attempts: state.config.outbound.maxRetries, baseDelayMs: 500 },
      }),
      maxMessageLength: state.config.outbound.maxMessageLength,
    });
    state.bridge = new Bridge({
      ctx,
      transport: state.transport,
      getConfig: () => state.config,
      onStateChange: refreshAllPanels,
      onTurnRunning: (chatId, running) => (running ? startTyping(chatId) : stopTyping(chatId)),
      log,
    });
    state.bridge.attach();

    state.interactive = attachInteractive(ctx, {
      broadcast: async (text, keyboard) => {
        const delivered: { chatId: number; messageId: number }[] = [];
        for (const chatId of [...state.chats]) {
          const id = await state.transport?.sendText(chatId, plain(text), {
            parse_mode: "HTML",
            ...(keyboard === undefined ? {} : { reply_markup: keyboard as never }),
          });
          if (id !== undefined) delivered.push({ chatId, messageId: id });
        }
        return delivered;
      },
      edit: async (chatId, messageId, text, keyboard) => {
        const t = state.transport;
        if (!t) return false;
        const edited = await t.editText(chatId, messageId, plain(text), {
          parse_mode: "HTML",
          ...(keyboard === undefined ? {} : { reply_markup: keyboard as never }),
        });
        return edited;
      },
    });

    // Every restart the client keeps the previous reply keyboard, which can
    // be a stale static `⌛ Queue` label from an older build. Re-assert the
    // live bar (count embedded) for every whitelisted chat on mount.
    for (const chatId of state.config.security.allowedChatIds) {
      state.chats.add(chatId);
      state.barCounts.set(chatId, -1);
      scheduleBarSync(chatId, 1500);
    }

    attachRouter({
      transport: state.transport,
      isAllowed: (chatId) => {
        state.chats.add(chatId);
        return isChatAllowed(state.config, chatId);
      },
      onCommand: (chatId, command, args) => void dispatchCommand(chatId, command, args).catch((err) => log("command failed", err)),
      onBarButton: (chatId, label) => void dispatchBarButton(chatId, label).catch((err) => log("bar button failed", err)),
      onCallback: (chatId, data) => void dispatchCallback(chatId, data).catch((err) => log("callback failed", err)),
      onPhoto: (chatId, fileId, caption) => void dispatchPhoto(chatId, fileId, caption).catch((err) => log("photo failed", err)),
      onUnauthorized: (chatId) => {
        log(`unauthorized prompt -> chatId ${chatId}`);
        void state.transport?.sendText(chatId, "\u{1F6AB} This chat is not allowed yet. Tap below to grant access:", {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "\u2795 Allow this chat", callback_data: "m:allowthis" }]] },
        }).catch(() => {});
      },
      onUserText: (chatId, text) => {
        void state.transport?.sendChatAction(chatId, "typing").catch(() => {});
        if (pendingSteer && pendingSteer.chatId === chatId) {
          const { sessionId } = pendingSteer;
          pendingSteer = undefined;
          const res = promptSession(requireCtx(), sessionId, text, "steer");
          void state.transport?.sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
          return;
        }
        if (pendingRename && pendingRename.chatId === chatId) {
          const sessionId = pendingRename.sessionId;
          pendingRename = undefined;
          const res = renameSession(requireCtx(), sessionId, text);
          void state.transport?.sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
          return;
        }
        if (pendingSubagentPrompt && pendingSubagentPrompt.chatId === chatId) {
          const { parentId, childId } = pendingSubagentPrompt;
          pendingSubagentPrompt = undefined;
          void promptSubagent(requireCtx(), parentId, childId, text)
            .then((res) => state.transport?.sendText(chatId, res.ok ? plain(res.text) : `\u274C ${plain(res.text)}`, { parse_mode: "HTML" }))
            .catch(() => {});
          return;
        }
        if (pendingQueueEdit && pendingQueueEdit.chatId === chatId) {
          const { itemId } = pendingQueueEdit;
          pendingQueueEdit = undefined;
          const queueAgent = currentAgent();
          if (!queueAgent) {
            void state.transport?.sendText(chatId, "\u274C No live agent owns the queue.", { parse_mode: "HTML" });
            return;
          }
          const editRes = updateQueueItem(requireCtx(), queueAgent.id, itemId, { kind: "edit", content: text });
          void state.transport?.sendText(chatId, editRes.ok ? plain(editRes.text) : `\u274C ${plain(editRes.text)}`, { parse_mode: "HTML" });
          refreshAllPanels();
          scheduleBarSync(chatId, 0);
          void openQueueCard(chatId);
          return;
        }
        // No live agent (fresh process): create one automatically so a plain
        // message always lands in a session (web semantics — the first prompt
        // starts a session).
        if (!currentAgent()) {
          void (async () => {
            const created = await sessionLifecycle.create(requireCtx(), state.workspaceRoot, state.config.model);
            if (created.agentId !== undefined) state.bridge?.setCurrentAgent(created.agentId);
            if (!created.result.ok) {
              void state.transport?.sendText(chatId, `\u274C ${plain(created.result.text)}`, { parse_mode: "HTML" });
              return;
            }
            const res = state.bridge!.deliver(chatId, text);
            if (!res.ok) void state.transport?.sendText(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
            else scheduleBarSync(chatId, 0);
          })();
          return;
        }
        const res = state.bridge!.deliver(chatId, text);
        if (!res.ok) void state.transport?.sendText(chatId, `\u274C ${plain(res.text)}`, { parse_mode: "HTML" });
        else scheduleBarSync(chatId, 0);
      },
    });
    ctx.on("agent/created", () => {
      if (state.config.watch.autoStart && !state.watching) {
        void startWatching().catch((err) => log("auto start failed", err));
      }
    });
    if (state.config.watch.autoStart && !state.watching) {
      void startWatching().catch((err) => log("auto start failed", err));
    }
  }

  ctx.commands.register({
    name: "telegram",
    description: "Telegram bridge controls: status | start | stop | allow <chatId> | disallow <chatId> | watch on|off | config auto-start | config get <path> | config set <path> <json>",
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      const parts = invocation.rawInput.trim().split(/\s+/);
      const [sub, arg] = parts as [string | undefined, string | undefined];
      try {
        if (!sub || sub === "status") return okCmd(renderStatus());
        if (sub === "start") {
          await startWatching();
          return okCmd("Telegram polling started.");
        }
        if (sub === "stop") {
          await stopWatching();
          return okCmd("Telegram polling stopped.");
        }
        if (sub === "allow" && arg) {
          const chatId = Number(arg);
          if (!Number.isInteger(chatId)) return failCmd("chatId must be an integer");
          if (!isChatAllowed(state.config, chatId)) {
            state.config.security.allowedChatIds.push(chatId);
            writeConfig(state.configRoot, state.config);
          }
          state.chats.add(chatId);
          return okCmd(`Allowed chat ${chatId}.`);
        }
        if (sub === "disallow" && arg) {
          const chatId = Number(arg);
          state.config.security.allowedChatIds = state.config.security.allowedChatIds.filter((id) => id !== chatId);
          writeConfig(state.configRoot, state.config);
          return okCmd(`Disallowed chat ${chatId}.`);
        }
        if (sub === "watch" && (arg === "on" || arg === "off")) {
          if (arg === "on") await startWatching();
          else await stopWatching();
          return okCmd(`watch=${arg}`);
        }
        if (sub === "config" && arg === "auto-start") {
          state.config.watch.autoStart = !state.config.watch.autoStart;
          writeConfig(state.configRoot, state.config);
          return okCmd(`autoStart=${state.config.watch.autoStart}`);
        }
        if (sub === "config" && arg === "get" && parts[2]) {
          return okCmd(JSON.stringify(getConfigPath(state.config, parts[2])));
        }
        if (sub === "config" && arg === "set" && parts[2]) {
          const value = JSON.parse(parts.slice(3).join(" "));
          const { config, changed } = overlayConfig(state.config, patchFromPath(parts[2], value));
          if (changed.length === 0) return failCmd(`unknown config path ${parts[2]}`);
          state.config = config;
          applyConfigLive(changed);
          writeConfig(state.configRoot, state.config);
          return okCmd(`config set ${parts[2]} \u2192 applied live + persisted`);
        }
        return failCmd("usage: /telegram status | start | stop | allow <chatId> | disallow <chatId> | watch on|off | config auto-start | config get <path> | config set <path> <json>");
      } catch (err) {
        return failCmd(err instanceof Error ? err.message : String(err));
      }
    },
  });

  ctx.tools.register(defineTool({
    name: "telegram_send",
    description: "Send an HTML message to one Telegram chat the bridge knows about.",
    parameters: {
      chatId: { type: "string", required: true, description: "Target chat id." },
      text: { type: "string", required: true, description: "Message body (HTML)." },
      parseMode: { type: "string", description: "HTML or MarkdownV2." },
      disableNotification: { type: "boolean", description: "Send silently." },
    },
    output: textOutput(),
    async execute(args) {
      const t = requireTransport();
      const id = await t.sendText(Number(args.chatId), args.text, {
        parse_mode: validateParseMode(args.parseMode),
        disable_notification: args.disableNotification === true,
      });
      return JSON.stringify({ ok: true, messageId: id ?? null });
    },
  }));

  ctx.tools.register(defineTool({
    name: "telegram_reply",
    description: "Reply to the current inbound Telegram message. Fails when there is no pending inbound message.",
    parameters: {
      text: { type: "string", required: true, description: "Reply body (HTML)." },
      parseMode: { type: "string", description: "HTML or MarkdownV2." },
      disableNotification: { type: "boolean", description: "Send silently." },
    },
    output: textOutput(),
    async execute(args) {
      const bridge = state.bridge;
      const inbound = bridge?.currentInbound();
      if (!bridge || !inbound) throw new Error("no active inbound message");
      await bridge.sendOutbound(inbound.chatId, args.text, {
        replyToInbound: true,
        parseMode: validateParseMode(args.parseMode),
        disableNotification: args.disableNotification === true,
      });
      return JSON.stringify({ ok: true, chatId: inbound.chatId });
    },
  }));

  ctx.tools.register(defineTool({
    name: "telegram_broadcast",
    description: "Send the same HTML message to several Telegram chats concurrently.",
    parameters: {
      targets: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: { chatId: { type: "string", required: true, description: "Target chat id." } },
        },
      },
      text: { type: "string", required: true, description: "Message body (HTML)." },
      parseMode: { type: "string", description: "HTML or MarkdownV2." },
    },
    output: textOutput(),
    async execute(args) {
      const t = requireTransport();
      const targets = (args.targets as { chatId?: string }[]).map((x) => x.chatId).filter((x): x is string => typeof x === "string");
      const results = await Promise.all(
        targets.map(async (chatId) => {
          try {
            const id = await t.sendText(Number(chatId), args.text, { parse_mode: validateParseMode(args.parseMode) });
            return { chatId, ok: true, messageId: id ?? null };
          } catch (err) {
            return { chatId, ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }),
      );
      return JSON.stringify({ ok: results.every((r) => r.ok), results });
    },
  }));

  ctx.tools.register(defineTool({
    name: "telegram_status",
    description: "Report the bridge's current state: bot connectivity, agent status, inbox queue, and known chats.",
    parameters: {},
    output: textOutput(),
    async execute() {
      return renderStatus();
    },
  }));

  ctx.tools.register(defineTool({
    name: "telegram_mark_no_reply",
    description: "Mark the current inbound Telegram message as intentionally not replied.",
    parameters: {
      reason: { type: "string", description: "Optional reason (not sent to the chat)." },
    },
    output: textOutput(),
    async execute(args) {
      const res = state.bridge ? state.bridge.markNoReply(args.reason ?? undefined) : { ok: false, text: "bridge not running" };
      return JSON.stringify(res);
    },
  }));

  ctx.effect(() => teardownMount);
}
