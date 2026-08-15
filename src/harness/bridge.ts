/**
 * The single harness<->telegram coupling point:
 * inbound text -> agent inbox, session events -> outbound chat.
 *
 * The bridge drives ONE agent at a time (the "current agent"): inbound text
 * goes to its inbox and only ITS session events are forwarded to the chat.
 * `/new` swaps the current agent; `/sessions` can rebind to another live one.
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent";
import { SessionId, type Session as DshSession } from "@deepseek-ai/dsh-session";
import { resolveInboundMode, type TelegramConfig } from "../config.js";
import { isReasoningEffort, reasoningDirective } from "../reasoning.js";
import { noteToolCall, renderStatsStrip, statusSnapshot } from "./adapters/status.js";
import { escapeHtml } from "../telegram/html.js";
import type { TelegramTransport } from "../telegram/transport.js";

/** Prepend the configured reasoning directive (codex-telegram-bot semantics). */
function withReasoningDirective(config: TelegramConfig, text: string): string {
  const effort = config.reasoning?.effort;
  if (effort === undefined || !isReasoningEffort(effort)) return text;
  const directive = reasoningDirective(effort);
  if (directive === "") return text;
  return `${directive}\n\n${text}`;
}

export interface BridgeOptions {
  ctx: Context;
  transport: TelegramTransport;
  getConfig: () => TelegramConfig;
  onStateChange: () => void;
  /** Turn lifecycle for chat indicators: running=true on turn/start, false on turn/end. */
  onTurnRunning?: (chatId: number, running: boolean) => void;
  log: (message: string, error?: unknown) => void;
}

interface Inbound {
  chatId: number;
  text: string;
  replied: boolean;
  noReply: boolean;
}

export class Bridge {
  private readonly ctx: Context;
  private readonly transport: TelegramTransport;
  private readonly getConfig: () => TelegramConfig;
  private readonly onStateChange: () => void;
  private readonly onTurnRunning: ((chatId: number, running: boolean) => void) | undefined;
  private readonly log: (message: string, error?: unknown) => void;
  private readonly disposers: (() => void)[] = [];

  private currentAgentId: ReturnType<typeof SessionId> | undefined;
  private activeChat: number | undefined;
  private inbound: Inbound | undefined;
  private assistantConsumer: ((chatId: number, text: string) => void) | undefined;
  private reminded = false;

  /** Active chat id for stream plugins (official session/event consumers). */
  activeChatValue(): number | undefined {
    return this.activeChat;
  }

  constructor(options: BridgeOptions) {
    this.ctx = options.ctx;
    this.transport = options.transport;
    this.getConfig = options.getConfig;
    this.onStateChange = options.onStateChange;
    this.onTurnRunning = options.onTurnRunning;
    this.log = options.log;
  }

  /** Resolve the agent this bridge is bound to (fallback: first live agent). */
  private resolveAgent() {
    if (this.currentAgentId !== undefined) {
      const bound = this.ctx.agents?.get(this.currentAgentId);
      if (bound) return bound;
    }
    return this.ctx.agents?.list()[0];
  }

  /** Bind future inbound/outbound to one live agent (id === session id). */
  setCurrentAgent(agentId: string | undefined): void {
    this.currentAgentId = agentId === undefined ? undefined : SessionId(agentId);
    this.onStateChange();
  }

  currentAgentIdValue(): string | undefined {
    return this.currentAgentId;
  }

  /** Route one inbound user text into the agent inbox per the inbound mode. */
  deliver(chatId: number, text: string): { ok: boolean; text: string } {
    const agent = this.resolveAgent();
    if (!agent) return { ok: false, text: "No live agent in this session." };
    const config = this.getConfig();
    const mode = resolveInboundMode(config, chatId, text);
    if (mode === "muted") return { ok: true, text: "Muted \u2014 message ignored." };

    const message = createUserMessage({
      content: [{ type: "text", text: withReasoningDirective(config, text) }],
      source: { kind: "user" },
    });
    if (mode === "queue-only") {
      agent.send(message, "next-turn", false);
    } else {
      agent.followup(message);
    }
    this.currentAgentId = agent.id;
    this.activeChat = chatId;
    this.inbound = { chatId, text, replied: false, noReply: false };
    this.reminded = false;
    return { ok: true, text: mode === "queue-only" ? "Queued." : "Delivered." };
  }

  /** Deliver one promoted image as the inbound turn (session.attachment path). */
  deliverImage(chatId: number, attachment: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string }, caption?: string): { ok: boolean; text: string } {
    const agent = this.resolveAgent();
    if (!agent) return { ok: false, text: "No live agent in this session." };
    const config = this.getConfig();
    const mode = resolveInboundMode(config, chatId, caption ?? "");
    if (mode === "muted") return { ok: true, text: "Muted \u2014 message ignored." };
    const content: unknown[] = [];
    if (caption && caption.trim()) content.push({ type: "text", text: withReasoningDirective(config, caption.trim()) });
    content.push({ type: "image", attachment });
    const message = createUserMessage({ content: content as never, source: { kind: "user" } });
    const target = agent as unknown as { send(message: unknown, target: string, wakeup: boolean): void; followup(message: unknown): void };
    if (mode === "queue-only") target.send(message, "next-turn", false);
    else target.followup(message);
    this.currentAgentId = agent.id;
    this.activeChat = chatId;
    this.inbound = { chatId, text: caption ?? "[image]", replied: false, noReply: false };
    this.reminded = false;
    return { ok: true, text: mode === "queue-only" ? "Image queued." : "Image delivered." };
  }

  /** telegram_reply / telegram_send entry point. */
  async sendOutbound(
    chatId: number,
    text: string,
    options?: { replyToInbound?: boolean; parseMode?: "HTML"; disableNotification?: boolean },
  ): Promise<void> {
    const config = this.getConfig();
    const extra: Record<string, unknown> = {
      parse_mode: options?.parseMode ?? config.outbound.parseMode,
      disable_notification: options?.disableNotification ?? config.outbound.disableNotification,
    };
    const inbound = options?.replyToInbound ? this.inbound : undefined;
    if (inbound && inbound.chatId === chatId && !inbound.replied) {
      inbound.replied = true;
    }
    await this.transport.sendText(chatId, text, extra);
  }

  markNoReply(reason?: string): { ok: boolean; text: string } {
    if (this.inbound) {
      this.inbound.noReply = true;
      this.inbound = undefined;
    }
    return { ok: true, text: reason ?? "Marked as no-reply." };
  }

  hasPendingInbound(): boolean {
    return this.inbound !== undefined && !this.inbound.replied && !this.inbound.noReply;
  }

  /** Stream-renderer plugin seam: when a consumer is registered the core
   * forwards assistant text blocks to it instead of the chat and defers the
   * inbound-answered bookkeeping to the consumer. No consumer = the built-in
   * immediate forwarding, byte-for-byte the pre-plugin behavior. */
  setAssistantConsumer(consumer: ((chatId: number, text: string) => void) | undefined): void {
    this.assistantConsumer = consumer;
  }

  /** Renderer plugins call this after delivering the final answer so the
   * core reminder never fires for an already-answered inbound. */
  markInboundReplied(): void {
    if (this.inbound) this.inbound.replied = true;
  }

  currentInbound(): Inbound | undefined {
    return this.inbound;
  }

  attach(): void {
    this.disposers.push(
      this.ctx.on("session/event", (session, event) => {
        // Only the bound agent's transcript reaches the chat: a stray event
        // from another agent (subagent, loop-owned startup agent) must not
        // leak replies into the conversation.
        const target = this.resolveAgent();
        if (!target || session.id !== target.id) return;
        if (event.type === "assistant/message" && this.activeChat !== undefined) {
          const text = event.data.message.content
            .filter((block) => block.type === "text")
            .map((block) => (block as { text: string }).text)
            .join("")
            .trim();
          if (text) {
            const consumer = this.assistantConsumer;
            if (consumer !== undefined) {
              // A stream-renderer plugin owns presentation and final delivery.
              consumer(this.activeChat, text);
            } else {
              // A prose reply satisfies the inbound message: the turn/end
              // reminder must not fire when the agent answered normally.
              if (this.inbound) this.inbound.replied = true;
              void this.transport
                .sendText(this.activeChat, escapeHtml(text), {
                  parse_mode: this.getConfig().outbound.parseMode,
                })
                .catch((err) => this.log("assistant reply failed", err));
            }
          }
        }
        if (event.type === "turn/start" && this.activeChat !== undefined) {
          this.onTurnRunning?.(this.activeChat, true);
        }
        if (event.type === "turn/end") {
          if (this.activeChat !== undefined) this.onTurnRunning?.(this.activeChat, false);
          // Surface LLM/infra errors verbatim instead of the generic
          // telegram_reply reminder (that reminder misled users when the
          // turn died before the model ever answered).
          const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } } | undefined)?.reason;
          const failure = reason?.kind === "error" ? reason.error?.message : undefined;
          if (failure !== undefined && failure.trim() !== "" && this.hasPendingInbound()) {
            this.inbound!.replied = true;
            this.reminded = true;
            const chatId = this.inbound!.chatId;
            void this.transport
              .sendText(chatId, `\u274C ${escapeHtml(failure.slice(0, 900))}`, { parse_mode: "HTML" })
              .catch(() => {});
          } else if (this.assistantConsumer === undefined && this.hasPendingInbound() && !this.reminded) {
            // No renderer plugin is active: the built-in reminder fires as
            // before. With a consumer registered, the plugin owns the final
            // delivery (and this reminder) and marks the inbound answered.
            this.reminded = true;
            const chatId = this.inbound!.chatId;
            void this.transport
              .sendText(chatId, "\u231B The turn ended without a telegram_reply \u2014 use the telegram_reply tool or reply yourself.", {
                parse_mode: "HTML",
              })
              .catch(() => {});
          }
          this.onStateChange();
        }
        // Live status feed: every event that changes turn/step/tool/usage
        // figures refreshes the open panels and the bar queue counter.
        if (
          event.type === "tool/call" ||
          event.type === "tool/result" ||
          event.type === "step/start" ||
          event.type === "step/end" ||
          event.type === "assistant/message" ||
          event.type === "turn/start"
        ) {
          if (event.type === "tool/call") noteToolCall(String(session.id));
          this.onStateChange();
        }
      }),
    );
    this.disposers.push(this.ctx.on("agent/status", () => this.onStateChange()));
  }

  detach(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
  }
}
