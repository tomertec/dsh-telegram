/**
 * Telegram Bot API access, following the official docs:
 *
 * - getUpdates long polling with `allowed_updates` narrowed to `message` and
 *   `callback_query` so the bot never pays for update kinds it does not use;
 * - HTML parse mode with all user content escaped upstream;
 * - every outbound call flows through the per-chat serial + global rate-limit
 *   queue, so the dsh agent loop is never blocked by network I/O.
 */
import { Bot, GrammyError, InputFile, type Api } from "grammy";
import { splitText } from "./html.js";
import { buildBarKeyboard } from "./keyboard.js";
import { SendQueue } from "./queue.js";

/** Bound one Bot API call: a hung connection must not wedge the send chain. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`telegram api timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export type UnsupportedMediaKind = "document" | "voice" | "video";

export interface TransportHandlers {
  onText: (chatId: number, text: string, messageId?: number) => void | Promise<void>;
  onPhoto: (chatId: number, fileId: string, caption: string, messageId?: number) => void | Promise<void>;
  onCallback: (chatId: number, data: string) => void | Promise<void>;
  /** Media the web seam cannot attach (only images have an attachment API). */
  onDocument?: (chatId: number, kind: UnsupportedMediaKind, fileId: string, name: string, mimeType: string, messageId?: number) => void | Promise<void>;
}

export interface TransportOptions {
  token: string;
  queue?: SendQueue;
  maxMessageLength?: number;
  log?: (message: string, error?: unknown) => void;
}

type SendOptions = NonNullable<Parameters<Api["sendMessage"]>[2]>;
type EditOptions = NonNullable<Parameters<Api["editMessageText"]>[3]>;

/** Bot API callback_query has no top-level `chat`; the chat lives on
 * `callback_query.message.chat`. Extracted so a unit test can lock this —
 * reading `callback.chat` silently dropped every inline tap (spinner stuck). */
export function callbackUpdateChatId(callback: {
  chat?: { id?: number };
  message?: { chat?: { id?: number } };
}): number | undefined {
  return callback.message?.chat?.id ?? callback.chat?.id;
}

export class TelegramTransport {
  readonly bot: Bot;
  readonly api: Api;
  private readonly queue: SendQueue;
  private maxMessageLength: number;
  private readonly log: (message: string, error?: unknown) => void;
  private handlers: TransportHandlers | undefined;
  private me: { id: number; username: string } | undefined;
  private polling = false;
  private starting = false;
  private pollAbort: AbortController | undefined;
  private pollLoop: Promise<void> | undefined;
  /** Last confirmed update id; preserved across stop/start generations so a
   * hot restart never asks Telegram to redeliver an already-seen batch. */
  private pollOffset = 0;

  constructor(options: TransportOptions) {
    this.bot = new Bot(options.token);
    this.api = this.bot.api;
    this.queue = options.queue ?? new SendQueue();
    this.maxMessageLength = options.maxMessageLength ?? 4096;
    this.log = options.log ?? ((m, e) => console.error(`[dsh-telegram] ${m}`, e ?? ""));
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  /** Hot-update rate limits and payload length without restarting polling. */
  applyLimits(options: { maxPerWindow?: number; retry?: { attempts: number; baseDelayMs: number }; maxMessageLength?: number }): void {
    this.queue.configure({
      ...(options.maxPerWindow === undefined ? {} : { maxPerWindow: options.maxPerWindow }),
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
    if (options.maxMessageLength !== undefined) this.maxMessageLength = options.maxMessageLength;
  }

  /** Route one raw update through the registered handlers. Callbacks are
   * answered first so the Telegram client stops showing the spinner. */
  private async handleUpdate(update: unknown): Promise<void> {
    const entry = update as {
      message?: {
        message_id?: number;
        chat?: { id?: number };
        text?: string;
        photo?: { file_id: string }[];
        caption?: string;
        document?: { file_id?: string; file_name?: string; mime_type?: string };
        voice?: { file_id?: string; mime_type?: string };
        video?: { file_id?: string; file_name?: string; mime_type?: string };
      };
      callback_query?: { chat?: { id?: number }; data?: string; id?: string; message?: { chat?: { id?: number } } };
    };
    if (!this.handlers) return;
    const message = entry.message;
    if (message?.chat?.id !== undefined && typeof message.text === "string") {
      this.log(`inbound text chatId=${message.chat.id} text=${JSON.stringify(message.text.slice(0, 80))}`);
      await this.handlers.onText(message.chat.id, message.text, message.message_id);
      return;
    }
    if (message?.chat?.id !== undefined && Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1]!;
      await this.handlers.onPhoto(message.chat.id, largest.file_id, message.caption ?? "", message.message_id);
      return;
    }
    if (message?.chat?.id !== undefined && this.handlers.onDocument !== undefined) {
      if (message.document !== undefined) {
        await this.handlers.onDocument(message.chat.id, "document", message.document.file_id ?? "", message.document.file_name ?? "document", message.document.mime_type ?? "", message.message_id);
        return;
      }
      if (message.voice !== undefined) {
        await this.handlers.onDocument(message.chat.id, "voice", message.voice.file_id ?? "", "voice message", message.voice.mime_type ?? "", message.message_id);
        return;
      }
      if (message.video !== undefined) {
        await this.handlers.onDocument(message.chat.id, "video", message.video.file_id ?? "", message.video.file_name ?? "video", message.video.mime_type ?? "", message.message_id);
        return;
      }
    }
    const callback = entry.callback_query;
    if (callback !== undefined) {
      // The chat lives on callback_query.message.chat — the callback_query
      // object itself has no top-level `chat` (Bot API shape). Reading
      // `callback.chat` here dropped every inline tap as `undefined`,
      // which made all inline buttons feel dead/stuck.
      const chatId = callbackUpdateChatId(callback);
      // Answer first: the Telegram client keeps a spinner until the callback
      // is acknowledged — without this every button feels dead.
      await withTimeout(this.api.answerCallbackQuery(callback.id ?? ""), 15_000).catch(() => {});
      if (callback.data === undefined || chatId === undefined) {
        this.log(`callback dropped: chat=${chatId} data=${String(callback.data ?? "").slice(0, 64)}`);
        return;
      }
      this.log(`inbound callback chatId=${chatId} data=${callback.data.slice(0, 64)}`);
      await this.handlers.onCallback(chatId, callback.data);
      return;
    }
  }

  /** Own getUpdates loop with per-call timeout and automatic reconnect:
   * grammY's bot.start() silently dies on one network error (no way to
   * observe it), which surfaced as the bot going mute. This loop never
   * stops unless stop() is called.
   *
   * start/stop are restart-safe: starting aborts and awaits any previous
   * generation first, so a hot re-apply can never have two in-flight
   * getUpdates requests on the same bot token (the 409 "terminated by other
   * getUpdates request" failure). */
  async start(): Promise<void> {
    if (this.polling || this.starting) return;
    this.starting = true;
    try {
      const previousAbort = this.pollAbort;
      previousAbort?.abort();
      const previousLoop = this.pollLoop;
      if (previousLoop) await previousLoop.catch(() => {});
      if (this.polling) return;

      const abort = new AbortController();
      this.pollAbort = abort;
      this.polling = true;
      this.pollLoop = (async () => {
        while (this.polling && this.pollAbort === abort) {
          try {
            const updates = await withTimeout(
              // grammY re-exports an AbortSignal shim for older runtimes;
              // Node's native AbortController is compatible at runtime.
              this.api.getUpdates({ offset: this.pollOffset, timeout: 25, allowed_updates: ["message", "callback_query"] }, abort.signal as never),
              40_000,
            );
            for (const update of updates) {
              this.pollOffset = update.update_id + 1;
              // Never let a slow handler block the poll loop: an agent turn can
              // take minutes, and a serial await would freeze inbound traffic
              // (the "bot went mute" failure).
              void this.handleUpdate(update).catch((err) => this.log("update handler failed", err));
            }
          } catch (err) {
            if (abort.signal.aborted) return;
            this.log("polling error (retrying in 2s)", err);
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      })();
      this.log("long polling started");
    } finally {
      this.starting = false;
    }
  }

  /** Stop the current polling generation and wait for its in-flight request
   * to settle so an immediate restart never overlaps getUpdates calls. */
  async stop(): Promise<void> {
    if (!this.polling && this.pollAbort === undefined) return;
    this.polling = false;
    const abort = this.pollAbort;
    abort?.abort();
    const loop = this.pollLoop;
    if (loop) await loop.catch(() => {});
    // A concurrent start() may have installed a new generation while this
    // stop was awaiting the old loop; only clear what this call owned.
    if (this.pollAbort === abort) this.pollAbort = undefined;
    if (this.pollLoop === loop) this.pollLoop = undefined;
  }

  /** Download one photo through the Bot API file endpoint. */
  async downloadFile(fileId: string): Promise<Uint8Array | undefined> {
    const file = await this.api.getFile(fileId).catch((err) => {
      this.log("getFile failed", err);
      return undefined;
    });
    if (!file?.file_path) return undefined;
    const url = `https://api.telegram.org/file/bot${this.bot.token}/${file.file_path}`;
    const response = await fetch(url).catch((err) => {
      this.log("photo download failed", err);
      return undefined;
    });
    if (!response?.ok) return undefined;
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Send a document (session-log ZIPs and other host artifacts). */
  sendDocument(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined> {
    return this.queue.push(chatId, async () => {
      const msg = await withTimeout(this.api.sendDocument(chatId, new InputFile(buffer, filename), {
        ...(caption === undefined ? {} : { caption, parse_mode: "HTML" as const }),
      }), 60_000);
      return msg.message_id;
    });
  }

  /** Send saved image bytes back to the chat (session.attachment read-back). */
  sendPhoto(chatId: number, buffer: Uint8Array, filename: string, caption?: string): Promise<number | undefined> {
    return this.queue.push(chatId, async () => {
      const msg = await withTimeout(this.api.sendPhoto(chatId, new InputFile(buffer, filename), {
        ...(caption === undefined ? {} : { caption, parse_mode: "HTML" as const }),
      }), 60_000);
      return msg.message_id;
    });
  }

  /** Remove/replace an inline keyboard in place (approval/question settles). */
  editReplyMarkup(chatId: number, messageId: number, markup: unknown): Promise<boolean> {
    return this.queue.push(chatId, async () => {
      try {
        await withTimeout(this.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: markup as never }), 20_000);
        return true;
      } catch (err) {
        if (err instanceof GrammyError) return false;
        throw err;
      }
    });
  }

/** Pending sends per chat + total — surfaced by the status card. */
  pending(): number {
    return this.queue.pendingCount();
  }

  async botInfo(): Promise<{ id: number; username: string } | undefined> {
    if (!this.me) {
      const info = await withTimeout(this.api.getMe(), 20_000).catch(() => undefined);
      if (info) this.me = { id: info.id, username: info.username };
    }
    return this.me;
  }

  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.api.setMyCommands(commands).catch((err) => this.log("setMyCommands failed", err));
  }

  sendText(chatId: number, text: string, options: SendOptions = {}): Promise<number | undefined> {
    const parts = splitText(text, this.maxMessageLength);
    return this.queue.push(chatId, async () => {
      let first: number | undefined;
      for (const part of parts) {
        const msg = await withTimeout(this.api.sendMessage(chatId, part, options), 20_000);
        if ((options as { reply_markup?: unknown }).reply_markup !== undefined) {
          this.log(`sendText reply_markup echo -> ${JSON.stringify(msg.reply_markup ?? null)}`);
        }
        first ??= msg.message_id;
      }
      return first;
    });
  }

  sendWithBar(chatId: number, text: string, options: SendOptions = {}): Promise<number | undefined> {
    return this.sendText(chatId, text, { ...options, reply_markup: buildBarKeyboard() });
  }

  editText(chatId: number, messageId: number, text: string, options: EditOptions = {}): Promise<boolean> {
    return this.queue.push(chatId, async () => {
      try {
        await withTimeout(this.api.editMessageText(chatId, messageId, text, options), 20_000);
        return true;
      } catch (err) {
        if (err instanceof GrammyError) return false;
        throw err;
      }
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<void> {
    return this.queue.push(chatId, async () => {
      await withTimeout(this.api.deleteMessage(chatId, messageId), 20_000);
    });
  }

  sendChatAction(chatId: number, action: "typing"): Promise<void> {
    return this.queue.push(chatId, async () => {
      await withTimeout(this.api.sendChatAction(chatId, action), 20_000);
    });
  }
}
