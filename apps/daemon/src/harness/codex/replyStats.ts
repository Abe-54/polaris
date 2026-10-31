/**
 * Times Codex's model calls on the session's own thread for `ReplyStats` (ENG-678). A call's
 * request goes out when the last item before it completes (the user's message, a command's
 * result); its first token is its first model item; it ends with `thread/tokenUsage/updated`,
 * whose `last` is that call's usage. Its last reply completes again with the stats.
 */
import { ReplyStats, type TurnId, TurnItem } from "@polaris/protocol";
import { HarnessEvent } from "../HarnessDriver.ts";

type AssistantMessage = typeof TurnItem.cases.AssistantMessage.Type;

/** A reply of the session's own thread, kept until its call's usage arrives. */
export interface CodexReply {
  readonly turnId: TurnId;
  readonly item: AssistantMessage;
}

/** The reply completed again, now with its call's stats. */
export const withStats = (reply: CodexReply, stats: ReplyStats): HarnessEvent =>
  HarnessEvent.ItemCompleted({
    turnId: reply.turnId,
    item: TurnItem.cases.AssistantMessage.make({
      id: reply.item.id,
      text: reply.item.text,
      startedAt: reply.item.startedAt,
      stats,
    }),
  });

/** Items Codex starts on its own, not from model output. */
const NOT_MODEL_OUTPUT = new Set([
  "userMessage",
  "subAgentActivity",
  "enteredReviewMode",
  "exitedReviewMode",
]);

export class CodexReplyTimer<T> {
  private lastCompletedAt: number | null = null;
  private requestedAt: number | null = null;
  private firstTokenAt: number | null = null;
  private reply: T | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** An item on the session's thread started, at Codex's stamp. */
  started(type: string, at: number | undefined): void {
    if (NOT_MODEL_OUTPUT.has(type) || at === undefined || this.firstTokenAt !== null) return;
    this.firstTokenAt = at;
    const requested = this.lastCompletedAt;
    this.requestedAt = requested !== null && requested <= at ? requested : null;
  }

  /** An item on the session's thread completed, at Codex's stamp. */
  completed(at: number | undefined): void {
    if (at !== undefined) this.lastCompletedAt = Math.max(this.lastCompletedAt ?? at, at);
  }

  /** A reply completed in the call in flight. */
  replied(reply: T): void {
    this.reply = reply;
  }

  /** The call ended with this usage: its last reply, to complete again with its stats. */
  ended(outputTokens: number): { reply: T; stats: ReplyStats } | null {
    const { reply, firstTokenAt, requestedAt } = this;
    this.reply = null;
    this.firstTokenAt = null;
    this.requestedAt = null;

    if (reply === null || outputTokens <= 0) return null;

    const stats = new ReplyStats({
      outputTokens,
      latencyMs: firstTokenAt === null || requestedAt === null ? null : firstTokenAt - requestedAt,
      durationMs: firstTokenAt === null ? null : Math.max(0, this.now() - firstTokenAt),
    });

    return { reply, stats };
  }

  /** The Turn ended: the next Turn's first request is timed from its own items. */
  turnEnded(): void {
    this.lastCompletedAt = null;
    this.ended(0);
  }
}
