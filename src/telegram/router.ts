/**
 * Inbound routing, per chat:
 *   slash command  -> onCommand   (whitelist-checked)
 *   bar button     -> onBarButton (whitelist-checked)
 *   inline callback-> onCallback  (whitelist-checked)
 *   other text     -> onUserText  (whitelist-checked, feeds the agent inbox)
 */
import { normalizeBarLabel } from "./keyboard.js";
import type { TelegramTransport } from "./transport.js";

export interface RouterDeps {
  transport: TelegramTransport;
  isAllowed: (chatId: number) => boolean;
  onCommand: (chatId: number, command: string, args: string, messageId?: number) => void | Promise<void>;
  onBarButton: (chatId: number, label: string) => void | Promise<void>;
  onCallback: (chatId: number, data: string) => void | Promise<void>;
  onUserText: (chatId: number, text: string, messageId?: number) => void | Promise<void>;
  onPhoto: (chatId: number, fileId: string, caption: string, messageId?: number) => void | Promise<void>;
  onDocument: (chatId: number, kind: "document" | "voice" | "video", fileId: string, name: string, mimeType: string, messageId?: number) => void | Promise<void>;
  onUnauthorized: (chatId: number, reason?: string) => void | Promise<void>;
}

const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/;

/** FIFO chains per chat: Telegram updates for one chat run strictly in
 * arrival order (two rapid first messages cannot create two sessions),
 * while different chats still proceed in parallel. */
const chains = new Map<number, Promise<unknown>>();

function enqueue(chatId: number, task: () => unknown | Promise<unknown>): Promise<void> {
  const previous = chains.get(chatId) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(task)
    .then(() => {});
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(chatId, settled);
  void settled.then(() => {
    if (chains.get(chatId) === settled) chains.delete(chatId);
  });
  return run;
}

export function attachRouter(deps: RouterDeps): void {
  deps.transport.setHandlers({
    onText: (chatId, text, messageId) =>
      enqueue(chatId, async () => {
        const match = COMMAND_RE.exec(text.trim());
        if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId, match ? `command:${match[1]}` : undefined);
        const barLabel = normalizeBarLabel(text);
        if (barLabel !== undefined) return deps.onBarButton(chatId, barLabel);
        if (match) return deps.onCommand(chatId, match[1]!, (match[2] ?? "").trim(), messageId);
        return deps.onUserText(chatId, text, messageId);
      }),
    onPhoto: (chatId, fileId, caption, messageId) =>
      enqueue(chatId, async () => {
        if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId);
        return deps.onPhoto(chatId, fileId, caption, messageId);
      }),
    onDocument: (chatId, kind, fileId, name, mimeType, messageId) =>
      enqueue(chatId, async () => {
        if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId);
        return deps.onDocument(chatId, kind, fileId, name, mimeType, messageId);
      }),
    onCallback: (chatId, data) =>
      enqueue(chatId, async () => {
        if (!deps.isAllowed(chatId) && data !== "m:allowthis") return;
        return deps.onCallback(chatId, data);
      }),
  });
}
