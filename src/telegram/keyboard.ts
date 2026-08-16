/**
 * Pure keyboard builders.
 *
 * - The persistent reply-keyboard bar carries the 9 hot functions
 *   (3 rows x 3). `BAR_LABELS` keeps superseded labels so stale
 *   persisted bars on clients still dispatch correctly.
 * - The `☰ Menu` inline card carries the paginated CORE rows.
 * - The "all functions" inline card is available through `⚙️ All` callbacks.
 *
 * Builders are pure: no dsh imports, no I/O, trivially unit-testable.
 */
import { InlineKeyboard, Keyboard } from "grammy";

export const MENU_BTN = "\u2630 Menu";
export const NEW_BTN = "\u2728 New";
export const COMPACT_BTN = "\u{1F9F9} Compact";
export const MODELS_BTN = "\u{1F9E9} Models";
export const PLUGINS_BTN = "\u{1F50C} Plugins";
export const MODE_BTN = "\u{1F3AD} Mode";
export const SESSIONS_BTN = "\u{1F9ED} Sessions";
export const STATUS_BTN = "\u{1F4CA} Status";
export const QUEUE_BTN = "\u231B Queue";
export const QUEUE_BTN_PREFIX = `${QUEUE_BTN} \u00B7 `;
export const PRESETS_BTN = "\u{1F3AD} Presets";
export const THINKING_BTN = "\u{1F9E0} Thinking";
/** Bar label for the reasoning picker (unified name; THINKING_BTN kept for
 * stale client bars). */
export const REASONING_BTN = "\u{1F9E0} Reasoning";
export const STOP_BTN = "\u23F9 Stop";

export const BAR_LABELS: readonly string[] = [
  MENU_BTN,
  NEW_BTN,
  COMPACT_BTN,
  MODELS_BTN,
  PLUGINS_BTN,
  MODE_BTN,
  SESSIONS_BTN,
  STATUS_BTN,
  QUEUE_BTN,
  REASONING_BTN,
  THINKING_BTN,
  PRESETS_BTN,
  STOP_BTN,
];

/** Queue button label with a live count embedded (`⌛ Queue · 3`). */
export function queueBarLabel(queueCount: number): string {
  return `${QUEUE_BTN_PREFIX}${queueCount}`;
}

/** Always-visible bar grouped by frequency:
 * `Menu · New · Models` / `Sessions · Plugins · Status` /
 * `Presets · Queue · Compact` / `Stop`. `🧠 Reasoning` stays reachable from
 * the menu P1. Pass `queueCount` to embed the live inbox count. */
export function buildBarKeyboard(queueCount?: number): Keyboard {
  return new Keyboard()
    .text(MENU_BTN)
    .text(NEW_BTN)
    .text(MODELS_BTN)
    .row()
    .text(SESSIONS_BTN)
    .text(PLUGINS_BTN)
    .text(STATUS_BTN)
    .row()
    .text(PRESETS_BTN)
    .text(queueCount === undefined ? QUEUE_BTN : queueBarLabel(queueCount))
    .text(COMPACT_BTN)
    .row()
    .text(STOP_BTN)
    .resized()
    .persistent();
}

/** Map inbound bar-button text back to its canonical label. The Queue
 * button's text changes as the live count is embedded (`⌛ Queue · 7`), so
 * exact BAR_LABELS matching alone would drop those taps. */
export function normalizeBarLabel(text: string): string | undefined {
  if ((BAR_LABELS as readonly string[]).includes(text)) return text;
  if (text.startsWith(QUEUE_BTN_PREFIX)) return QUEUE_BTN;
  return undefined;
}

export interface CoreMenuState {
  model: string;
  /** Omitted for models without reasoning controls (hidden row, pi-style). */
  thinking?: string;
  queueCount: number;
  /** Active project folder name (Codex-style). */
  project?: string;
}

/** `☐ Menu` core card: pi-telegram status-menu style — full-width
 * status rows up top, then segmented domain rows, then full-width closers. */
export function buildCoreMenu(state: CoreMenuState): InlineKeyboard {
  const kb = new InlineKeyboard().text(`${MODELS_BTN} \u00B7 ${state.model}`, "m:models");
  if (state.thinking !== undefined) kb.row().text(`\u{1F9E0} Thinking \u00B7 ${state.thinking}`, "m:thinking");
  kb.row().text(`\u231B Queue \u00B7 ${state.queueCount}`, "m:queue");
  kb.row().text(`\u{1F4C1} Project \u00B7 ${state.project ?? "..."}`, "m:project");
  kb.row().text(NEW_BTN, "m:new").text(COMPACT_BTN, "m:compact");
  kb.row().text(SESSIONS_BTN, "m:sessions");
  kb.row().text(STATUS_BTN, "m:status").text(PLUGINS_BTN, "m:plugins");
  kb.row().text(MODE_BTN, "m:mode");
  kb.row().text("\u{1F5C2} Workspaces", "m:workspaces").text("\u{1F3AF} Goals", "m:goals");
  kb.row().text("\u{1F9EC} Skills", "m:skills").text("\u{1F916} Subagents", "m:subagents");
  kb.row().text("\u{1F3AD} Presets", "m:presets").text("\u{1F6E0}\uFE0F Host settings", "m:hostsettings");
  kb.row().text("\u{1F511} Credentials", "m:credentials").text("\u{1F4BB} Host", "m:host");
  kb.row().text("\u{1F4CB} Jobs", "m:jobs").text("\u269B\uFE0F Dynamic", "m:dynamic");
  kb.row().text("\u{1F9EC} Capabilities", "m:capabilities");
  kb.row().text("\u2699\uFE0F Settings", "m:settings");
  kb.row().text("\u2716 Close", "m:close");
  return kb;
}

export interface MenuItem {
  label: string;
  cb: string;
  /** Full-width row; otherwise items pair two-per-row. */
  full?: boolean;
}

/** Dense paginated menu (codex-bridge style): primary items full-width,
 * the rest paired two-per-row, then prev/page/next + close. */
export function buildMenuPage(items: readonly MenuItem[], page: number, total: number): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  const pair: { text: string; callback_data: string }[] = [];
  const flush = () => {
    if (pair.length > 0) {
      rows.push([...pair]);
      pair.length = 0;
    }
  };
  for (const item of items.slice(0, 30)) {
    const button = { text: item.label.slice(0, 32), callback_data: item.cb };
    if (item.full) {
      flush();
      rows.push([button]);
    } else {
      pair.push(button);
      if (pair.length === 2) flush();
    }
  }
  flush();
  const nav: { text: string; cb: string }[] = [];
  if (page > 0) nav.push({ text: "\u2B05\uFE0F Prev", cb: "m:prev" });
  nav.push({ text: `${page + 1}/${total}`, cb: "m:page" });
  if (page < total - 1) nav.push({ text: "More \u27A1\uFE0F", cb: "m:more" });
  if (nav.length > 0) {
    rows.push(nav.map((button) => ({ text: button.text, callback_data: button.cb })));
  }
  rows.push([{ text: "\u2716 Close", callback_data: "m:close" }]);
  return InlineKeyboard.from(rows);
}

/** Single "back to menu" row for domain cards that only need one action. */
export function buildBackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("\u2190 Back", "m:back");
}

/** Two-button confirmation row for destructive actions. */
export function buildConfirmKeyboard(callbacks: { confirm: string; cancel: string }): InlineKeyboard {
  return new InlineKeyboard()
    .text("\u2705 Confirm", callbacks.confirm)
    .text("\u2716 Cancel", callbacks.cancel);
}

export interface ProjectRow {
  label: string;
  cb: string;
}

export interface ProjectActions {
  up?: string;
  home?: string;
  root?: string;
  use?: string;
  close?: string;
  quick?: readonly ProjectRow[];
  paging?: readonly { text: string; cb: string }[];
}

/** Folder picker: nav row (Up/Home/Root) + quick workspace paths, then
 * directory entries two per row, then Use/Close. Pure builder — callback
 * payloads are pre-encoded by index.ts. */
export function buildProjectKeyboard(dirs: readonly ProjectRow[], actions: ProjectActions): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  const nav: { text: string; cb: string }[] = [];
  if (actions.up !== undefined) nav.push({ text: "\u2B06\uFE0F Up", cb: actions.up });
  if (actions.home !== undefined) nav.push({ text: "\u{1F3E0} ~", cb: actions.home });
  if (actions.root !== undefined) nav.push({ text: "\u{1F5A5}\uFE0F /", cb: actions.root });
  if (nav.length > 0) {
    rows.push(nav.slice(0, 3).map((button) => ({ text: button.text, callback_data: button.cb })));
  }
  for (const quick of (actions.quick ?? []).slice(0, 3)) rows.push([{ text: quick.label.slice(0, 40), callback_data: quick.cb }]);
  const seen = new Set<string>();
  const pairs: { text: string; callback_data: string }[] = [];
  for (const entry of dirs) {
    if (seen.has(entry.cb)) continue;
    seen.add(entry.cb);
    pairs.push({ text: `\u{1F4C1} ${entry.label.slice(0, 26)}`, callback_data: entry.cb });
  }
  for (let index = 0; index < pairs.length; index += 2) {
    rows.push(index + 1 < pairs.length ? [pairs[index]!, pairs[index + 1]!] : [pairs[index]!]);
  }
  const paging: { text: string; callback_data: string }[] = [];
  for (const button of (actions.paging ?? []).slice(0, 3)) {
    paging.push({ text: button.text.slice(0, 40), callback_data: button.cb });
  }
  if (paging.length > 0) rows.push(paging);
  const footer: { text: string; callback_data: string }[] = [];
  if (actions.use !== undefined) footer.push({ text: "\u2705 Use this folder", callback_data: actions.use });
  if (actions.close !== undefined) footer.push({ text: "\u2716 Close", callback_data: actions.close });
  if (footer.length > 0) rows.push(footer);
  return InlineKeyboard.from(rows);
}

export const CALLBACK_RE = /^m:([a-z]+)(?::([\s\S]+))?$/;

// ---------------------------------------------------------------------------
// v0.2 web-parity cards: every domain gets a card + detail rows. Builders stay
// pure — callback payloads are encoded by index.ts and passed in as strings.
// ---------------------------------------------------------------------------

export interface SessionsPaging {
  previous?: string;
  next?: string;
}

/** Generic pagination row for text-heavy cards plus a back button. */
export function buildPagingKeyboard(callbacks: { previous?: string; next?: string; back: string }): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  if (callbacks.previous !== undefined || callbacks.next !== undefined) {
    const nav: { text: string; callback_data: string }[] = [];
    if (callbacks.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: callbacks.previous });
    if (callbacks.next !== undefined) nav.push({ text: "More \u203A", callback_data: callbacks.next });
    rows.push(nav);
  }
  rows.push([{ text: "\u2190 Back", callback_data: callbacks.back }]);
  return InlineKeyboard.from(rows);
}

export function buildSearchKeyboard(ids: readonly string[], paging?: SessionsPaging): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const id of ids.slice(0, 8)) {
    rows.push([{ text: `\u{1F9ED} ${id.slice(0, 30)}`, callback_data: `s:${id}`.slice(0, 64) }]);
  }
  if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
    const nav: { text: string; callback_data: string }[] = [];
    if (paging.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
    if (paging.next !== undefined) nav.push({ text: "More \u203A", callback_data: paging.next });
    rows.push(nav);
  }
  rows.push([{ text: "\u{1F50D} New search", callback_data: "m:search" }, { text: "\u2190 Sessions", callback_data: "m:sessions" }]);
  return InlineKeyboard.from(rows);
}

export function buildSessionsKeyboard(ids: readonly string[], paging?: SessionsPaging): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [
    [{ text: "\u2728 New session", callback_data: "m:new" }, { text: "\u23F9 Stop", callback_data: "m:stop" }],
    [{ text: "\u{1F50D} Search", callback_data: "m:search" }],
  ];
  for (const id of ids.slice(0, 10)) {
    rows.push([{ text: `\u{1F9ED} ${id.slice(0, 30)}`, callback_data: `s:${id}`.slice(0, 64) }]);
  }
  if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
    const nav: { text: string; callback_data: string }[] = [];
    if (paging.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
    if (paging.next !== undefined) nav.push({ text: "More \u203A", callback_data: paging.next });
    rows.push(nav);
  }
  rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
  return InlineKeyboard.from(rows);
}

export function buildHistoryKeyboard(sessionId: string, older?: string): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  if (older !== undefined) rows.push([{ text: "\u23EA Load older", callback_data: older }]);
  rows.push([{ text: "\u2190 Session", callback_data: `s:${sessionId}`.slice(0, 64) }]);
  return InlineKeyboard.from(rows);
}

export function buildSessionDetailKeyboard(id: string, archived: boolean): InlineKeyboard {
  const prefix = `s:${id}`.slice(0, 52);
  const kb = new InlineKeyboard();
  kb.row().text("\u{1F3AF} Use", `${prefix}:use`.slice(0, 64));
  kb.row().text("\u{1F4DC} History", `${prefix}:history`.slice(0, 64)).text("\u270F Rename", `${prefix}:rename`.slice(0, 64));
  kb.row().text("\u{1F500} Fork", `${prefix}:fork`.slice(0, 64)).text(archived ? "\u{1F4E5} Archived" : "\u{1F5C4} Archive", `${prefix}:archive`.slice(0, 64));
  kb.row().text("\u{1F4CE} Model", `${prefix}:model`.slice(0, 64)).text("\u231B Queue", `${prefix}:queue`.slice(0, 64));
  kb.row().text("\u{1F3AF} Steer", `${prefix}:steer`.slice(0, 64)).text("\u{1F4E6} Log", `${prefix}:log`.slice(0, 64));
  kb.row().text("\u23F9 Stop", `${prefix}:stop`.slice(0, 64)).text("\u{1F5D1} Delete", `${prefix}:delete`.slice(0, 64));
  return kb.row().text("\u2190 Sessions", "m:sessions");
}

export function buildWorkspaceKeyboard(items: readonly { id: string; title: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items.slice(0, 20)) {
    kb.text(`\u{1F5C2} ${item.title.slice(0, 30)}`, `w:${item.id}`.slice(0, 64)).row();
  }
  return kb.row().text("\u2795 Create", "w:create").text("\u2190 Back", "m:back");
}

export function buildWorkspaceDetailKeyboard(id: string): InlineKeyboard {
  const prefix = `w:${id}`.slice(0, 52);
  const kb = new InlineKeyboard();
  kb.row().text("\u270F Rename", `${prefix}:rename`.slice(0, 64)).text("\u{1F5D1} Delete", `${prefix}:delete`.slice(0, 64));
  kb.row().text("\u2B06 Move up", `${prefix}:up`.slice(0, 64)).text("\u2193 Move down", `${prefix}:down`.slice(0, 64));
  kb.row().text("\u{1F4CC} Pin session first", `${prefix}:pin`.slice(0, 64));
  return kb.row().text("\u2190 Workspaces", "m:workspaces");
}

export function buildQueueKeyboard(items: readonly { itemId: string; kind: "next-turn" | "next-step" }[]): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const item of items.slice(0, 24)) {
    const prefix = `q:${item.itemId}`.slice(0, 52);
    const row: { text: string; callback_data: string }[] = [
      { text: `\u270F ${item.itemId.slice(0, 8)}`, callback_data: `${prefix}:e`.slice(0, 64) },
      { text: `\u{1F5D1} ${item.itemId.slice(0, 8)}`, callback_data: `${prefix}:r`.slice(0, 64) },
    ];
    if (item.kind === "next-turn") row.push({ text: `\u26A1 ${item.itemId.slice(0, 8)}`, callback_data: `${prefix}:s`.slice(0, 64) });
    rows.push(row);
  }
  rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
  return InlineKeyboard.from(rows);
}

export function buildModelsKeyboard(groups: readonly { id: string; name: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const group of groups.slice(0, 20)) {
    kb.text(`\u{1F4E1} ${group.name.slice(0, 30)}`, `mo:${group.id}`.slice(0, 64)).row();
  }
  return kb.row().text("\u{1F50D} Discover models", "m:discover").text("\u2190 Back", "m:back");
}

export interface ModelPaging {
  previous?: string;
  next?: string;
}

export function buildModelDetailKeyboard(
  models: readonly { id: string; name: string; cb: string }[],
  thinking?: { label: string; cb: string },
  paging?: ModelPaging,
): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const model of models.slice(0, 12)) {
    rows.push([{ text: `${model.name.slice(0, 40)}${model.id === model.name ? "" : ` \u00B7 ${model.id.slice(0, 20)}`}`.slice(0, 60), callback_data: model.cb }]);
  }
  if (paging !== undefined && (paging.previous !== undefined || paging.next !== undefined)) {
    const nav: { text: string; callback_data: string }[] = [];
    if (paging.previous !== undefined) nav.push({ text: "\u2039 Prev", callback_data: paging.previous });
    if (paging.next !== undefined) nav.push({ text: "More \u203A", callback_data: paging.next });
    rows.push(nav);
  }
  if (thinking !== undefined) rows.push([{ text: `\u{1F9E0} Thinking \u00B7 ${thinking.label}`.slice(0, 64), callback_data: thinking.cb }]);
  rows.push([{ text: "\u2190 Providers", callback_data: "m:models" }]);
  return InlineKeyboard.from(rows);
}

/** Reasoning-effort picker: the fixed codex-telegram-bot levels
 * (minimal/low/medium/high/max), backend-independent. */
export function buildThinkingKeyboard(options: readonly { id: string; name: string; cb: string }[], current?: string): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [];
  for (const option of options) {
    const checked = option.id === current;
    rows.push([{ text: `${checked ? "\u2705" : "\u25CB"} ${option.name.slice(0, 40)}`, callback_data: option.cb }]);
  }
  rows.push([{ text: "\u2190 Back", callback_data: "m:back" }]);
  return InlineKeyboard.from(rows);
}

export function buildGoalsKeyboard(hasGoal: boolean, callbacks: { create: string; edit: string; pause: string; resume: string; complete: string; clear: string }): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (hasGoal) {
    kb.row().text("\u270F Edit", callbacks.edit).text("\u23F8 Pause", callbacks.pause).text("\u25B6 Resume", callbacks.resume);
    kb.row().text("\u2705 Complete", callbacks.complete).text("\u{1F5D1} Clear", callbacks.clear);
  } else {
    kb.row().text("\u2795 Create goal", callbacks.create);
  }
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildSkillsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}

export function buildSubagentsKeyboard(entries: readonly { id: string; cb: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const entry of entries.slice(0, 20)) {
    kb.text(`\u{1F916} ${entry.id.slice(0, 30)}`, entry.cb).row();
  }
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildSubagentDetailKeyboard(callbacks: { prompt?: string; interrupt?: string; history: string }): InlineKeyboard {
  const kb = new InlineKeyboard();
  const actions: { text: string; callback_data: string }[] = [];
  if (callbacks.prompt !== undefined) actions.push({ text: "\u{1F4E8} Prompt", callback_data: callbacks.prompt });
  if (callbacks.interrupt !== undefined) actions.push({ text: "\u23F9 Interrupt", callback_data: callbacks.interrupt });
  actions.push({ text: "\u{1F4DC} History", callback_data: callbacks.history });
  kb.row(...actions.slice(0, 3));
  return kb.row().text("\u2190 Subagents", "m:subagents");
}

export function buildPresetsKeyboard(entries: readonly { id: string; cb: string }[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const entry of entries.slice(0, 20)) {
    kb.text(`${entry.id.slice(0, 34)}${entry.id.length > 34 ? "\u2026" : ""}`, entry.cb).row();
  }
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildPresetDetailKeyboard(callbacks: { select: string; read: string; create: string; copy: string; remove: string; open: string; default: string }): InlineKeyboard {
  return new InlineKeyboard()
    .row()
    .text("\u{1F3AD} Select", callbacks.select)
    .text("\u{1F4C4} Read", callbacks.read)
    .row()
    .text("\u2728 New with this preset", callbacks.create)
    .row()
    .text("\u{1F4CB} Copy", callbacks.copy)
    .text("\u{1F5D1} Remove", callbacks.remove)
    .row()
    .text("\u2B50 Set default", callbacks.default)
    .row()
    .text("\u{1F4C2} Open document", callbacks.open)
    .row()
    .text("\u2190 Presets", "m:presets");
}

export function buildSettingsKeyboard(namespaces: readonly string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const ns of namespaces.slice(0, 20)) {
    kb.text(ns.slice(0, 40), `set:${ns}`.slice(0, 64)).row();
  }
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildCredentialsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u{1F511} Describe ref", "m:cred-describe").text("\u2190 Back", "m:back");
}

export function buildHostKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.row().text("\u{1F4C2} Browse cwd", "h:browse");
  kb.row().text("\u{1F4C1} Mkdir", "h:mkdir");
  return kb.row().text("\u2190 Back", "m:back");
}

export function buildJobsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}

export function buildDynamicCordisKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}

export function buildCapabilitiesKeyboard(): InlineKeyboard {
  return new InlineKeyboard().row().text("\u2190 Back", "m:back");
}

export function buildFeedbackKeyboard(callbacks: { positive: string; negative: string; list: string }): InlineKeyboard {
  return new InlineKeyboard().row().text("\u{1F44D}", callbacks.positive).text("\u{1F44E}", callbacks.negative).text("\u{1F4CB} Feedback list", callbacks.list);
}
