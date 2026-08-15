/**
 * One live status card per chat, updated in place via editMessageText so
 * frequent refreshes never spam the conversation. Identical content is
 * skipped entirely; a deleted message falls back to a fresh send.
 */
import { ChatOps } from "./ephemeral.js";

export interface PanelOps extends ChatOps {
  editText(chatId: number, messageId: number, text: string, options?: Record<string, unknown>): Promise<boolean>;
}

interface Panel {
  messageId?: number;
  text?: string;
}

export class StatusPanel {
  private readonly panels = new Map<number, Panel>();
  private readonly locks = new Map<number, Promise<unknown>>();

  private serialize<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(chatId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(chatId, run.then(noop, noop));
    return run;
  }

  /** Create the card on demand (Status button / command) or update it in
   * place when one already exists (live event feed). */
  refresh(chatId: number, ops: PanelOps, text: string, createIfMissing = false): Promise<void> {
    return this.serialize(chatId, async () => {
      const panel = this.panels.get(chatId);
      if (panel === undefined && !createIfMissing) return;
      if (panel?.text === text) return;
      if (panel?.messageId !== undefined) {
        const edited = await ops.editText(chatId, panel.messageId, text).catch(() => false);
        if (edited) {
          panel.text = text;
          return;
        }
      }
      if (!createIfMissing) return;
      const id = await ops.sendText(chatId, text).catch(() => undefined);
      if (id === undefined) return;
      this.panels.set(chatId, { messageId: id, text });
    });
  }

  /** Drop all in-memory panels on plugin teardown (hot unplug / HMR). */
  reset(): void {
    this.panels.clear();
    this.locks.clear();
  }
}

function noop(): void {
  /* swallow chain errors */
}
