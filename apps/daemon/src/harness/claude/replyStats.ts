/**
 * Times Claude's model calls for `ReplyStats` (ENG-678), per scope (the Turn's own, `""`, or a
 * Subagent's). A call's request starts when the Turn begins, a Subagent starts, or tool results
 * go back; its first token is its first streamed delta; it ends with `message_delta`, whose
 * usage holds the call's final output tokens. A call whose request the driver didn't see (a
 * hook's retry, say) gets no latency rather than a guess.
 */
import { ReplyStats } from "@polaris/protocol";

interface Call<T> {
  readonly messageId: string;
  readonly requestedAt: number | null;
  firstTokenAt: number | null;
  stats: ReplyStats | null;
  /** The call's last reply block so far. */
  reply: T | null;
}

export class ReplyTimer<T> {
  private readonly requests = new Map<string, number>();
  private readonly calls = new Map<string, Call<T>>();

  /** A request goes out on this scope now. */
  requested(key: string, at: number): void {
    this.requests.set(key, at);
  }

  /** `message_start`: the request in flight has begun answering. */
  started(key: string, messageId: string): void {
    this.calls.set(key, {
      messageId,
      requestedAt: this.requests.get(key) ?? null,
      firstTokenAt: null,
      stats: null,
      reply: null,
    });
    this.requests.delete(key);
  }

  /** Any streamed delta: the first one is the call's first token. */
  token(key: string, at: number): void {
    const call = this.calls.get(key);

    if (call !== undefined && call.firstTokenAt === null) call.firstTokenAt = at;
  }

  /**
   * A reply block of `messageId` completes: the stats it carries, when the call has ended already.
   * Only the call's last reply block carries them.
   */
  reply(key: string, messageId: string, value: T): ReplyStats | null {
    const call = this.calls.get(key);

    if (call === undefined || call.messageId !== messageId) return null;
    call.reply = value;

    return call.stats;
  }

  /** `message_delta`: the call's last reply block so far, to complete again with its stats. */
  ended(key: string, outputTokens: number, at: number): { reply: T; stats: ReplyStats } | null {
    const call = this.calls.get(key);

    if (call === undefined || call.stats !== null) return null;
    const first = call.firstTokenAt;

    call.stats = new ReplyStats({
      outputTokens,
      latencyMs: first === null || call.requestedAt === null ? null : first - call.requestedAt,
      durationMs: first === null ? null : at - first,
    });

    return call.reply === null ? null : { reply: call.reply, stats: call.stats };
  }
}
