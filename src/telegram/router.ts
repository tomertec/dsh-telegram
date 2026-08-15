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
  onCommand: (chatId: number, command: string, args: string) => void | Promise<void>;
  onBarButton: (chatId: number, label: string) => void | Promise<void>;
  onCallback: (chatId: number, data: string) => void | Promise<void>;
  onUserText: (chatId: number, text: string) => void | Promise<void>;
  onPhoto: (chatId: number, fileId: string, caption: string) => void | Promise<void>;
  onUnauthorized: (chatId: number) => void | Promise<void>;
}

const COMMAND_RE = /^\/([a-zA-Z0-9_]+)(?:\s+([\s\S]*))?$/;

export function attachRouter(deps: RouterDeps): void {
  deps.transport.setHandlers({
    onText: (chatId, text) => {
      if (!deps.isAllowed(chatId)) return deps.onUnauthorized(chatId);
      const barLabel = normalizeBarLabel(text);
      if (barLabel !== undefined) return deps.onBarButton(chatId, barLabel);
      const match = COMMAND_RE.exec(text.trim());
      if (match) return deps.onCommand(chatId, match[1]!, (match[2] ?? "").trim());
      return deps.onUserText(chatId, text);
    },
    onPhoto: (chatId, fileId, caption) => {
      if (!deps.isAllowed(chatId)) return;
      return deps.onPhoto(chatId, fileId, caption);
    },
    onCallback: (chatId, data) => {
      if (!deps.isAllowed(chatId) && data !== "m:allowthis") return;
      return deps.onCallback(chatId, data);
    },
  });
}
