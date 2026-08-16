/**
 * Callback payload registry: keeps long ids/arguments out of Telegram's
 * 64-byte callback_data limit. Tokens are single-use — a tap executes exactly
 * once even when Telegram redelivers a callback or a stale message is tapped
 * again — and both ledgers stay bounded for long-running bots.
 */

export class TokenRegistry {
  private readonly tokens = new Map<number, Record<string, string>>();
  private readonly used = new Set<number>();
  private counter = Date.now();

  constructor(private readonly maxEntries = 1000) {}

  mint(payload: Record<string, string>): string {
    this.counter += 1;
    if (this.tokens.size >= this.maxEntries) {
      const oldest = this.tokens.keys().next().value;
      if (oldest !== undefined) this.tokens.delete(oldest);
    }
    this.tokens.set(this.counter, payload);
    return `t:${this.counter}`;
  }

  /** Remove and return the payload for a callback; `undefined` when unknown
   * or already consumed. */
  take(data: string): Record<string, string> | undefined {
    const id = Number(data.slice(2));
    if (!Number.isFinite(id)) return undefined;
    const payload = this.tokens.get(id);
    if (payload === undefined) return undefined;
    this.tokens.delete(id);
    this.used.add(id);
    if (this.used.size > this.maxEntries * 4) {
      let remove = this.used.size - this.maxEntries * 2;
      for (const old of this.used) {
        this.used.delete(old);
        remove -= 1;
        if (remove === 0) break;
      }
    }
    return payload;
  }

  /** Distinguish "already ran" from "card predates this bot process". */
  wasUsed(data: string): boolean {
    return this.used.has(Number(data.slice(2)));
  }

  pending(): number {
    return this.tokens.size;
  }

  reset(): void {
    this.tokens.clear();
    this.used.clear();
  }
}
