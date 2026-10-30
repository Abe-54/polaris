/**
 * Messages the user sent that the conversation doesn't show yet: a steer
 * until its Harness takes it (the Turn's `UserMessage` item), and a queued
 * follow-up until it starts the next Turn. Both show in the conversation
 * while they wait, and stay there with the reason when they don't land.
 */
import { Predicate } from "effect";
import type { TurnView } from "../../../store/sessionModel.ts";

export interface OutboxAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly hostPath: string;
  readonly width: number | null;
  readonly height: number | null;
}

export type OutboxStatus =
  /** A queued follow-up waiting for the Turn in flight to end. */
  | "waiting"
  /** Dispatched; the Daemon hasn't answered yet. */
  | "sending"
  /** The Daemon took it; waiting for it to land in the conversation. */
  | "sent"
  | "failed";

export interface Outgoing<A extends OutboxAttachment = OutboxAttachment> {
  readonly id: string;
  readonly kind: "steer" | "queued";
  readonly text: string;
  readonly attachments: ReadonlyArray<A>;
  /** A steer's Turn; null for a follow-up. */
  readonly turnId: string | null;
  /**
   * What the conversation held when it was sent: a steer's Turn's user
   * messages, or a follow-up's number of Turns. It lands past that.
   */
  readonly baseline: number;
  readonly status: OutboxStatus;
  /** Why it failed, as the user reads it. */
  readonly error: string | null;
  /** A follow-up shell command (`!…`): it runs as its own Turn. */
  readonly shell?: boolean;
}

/** Said when a steer's Turn ended without the Harness reporting it. */
export const MISSED_STEER = "The turn ended before it landed";

let counter = 0;

export const outgoingId = () => {
  counter += 1;

  return `out-${Date.now().toString(36)}-${counter}`;
};

/** The user messages (landed steers) of a Turn, in order. */
export const steersOf = (view: TurnView | undefined): ReadonlyArray<string> =>
  view === undefined
    ? []
    : view.items.flatMap((item) =>
        Predicate.isTagged(item, "UserMessage") ? [item.text.trim()] : []
      );

const findTurn = (turns: ReadonlyArray<TurnView>, turnId: string | null) =>
  turnId === null ? undefined : turns.find((t) => t.turn.id === turnId);

/** A new steer of the Turn in flight, sending. */
export const steerOutgoing = <A extends OutboxAttachment>(
  turns: ReadonlyArray<TurnView>,
  turnId: string,
  text: string,
  attachments: ReadonlyArray<A> = []
): Outgoing<A> => ({
  id: outgoingId(),
  kind: "steer",
  text: text.trim(),
  attachments,
  turnId,
  baseline: steersOf(findTurn(turns, turnId)).length,
  status: "sending",
  error: null,
});

/** A follow-up queued for after the Turn in flight. */
export const queuedOutgoing = <A extends OutboxAttachment>(
  text: string,
  attachments: ReadonlyArray<A>,
  shell = false
): Outgoing<A> => ({
  id: outgoingId(),
  kind: "queued",
  text,
  attachments,
  turnId: null,
  baseline: 0,
  status: "waiting",
  error: null,
  shell,
});

type Settled<A extends OutboxAttachment> = Outgoing<A> | null;

/** One steer against its Turn: null once landed (the landing index goes in `used`). */
const settleSteer = <A extends OutboxAttachment>(
  entry: Outgoing<A>,
  turns: ReadonlyArray<TurnView>,
  used: Map<string, number>
): Settled<A> => {
  if (entry.status !== "sent" || entry.turnId === null) return entry;
  const view = findTurn(turns, entry.turnId);
  const steers = steersOf(view);
  const from = Math.max(entry.baseline, used.get(entry.turnId) ?? 0);
  const at = steers.findIndex((text, n) => n >= from && text === entry.text);

  if (at !== -1) {
    used.set(entry.turnId, at + 1);

    return null;
  }

  if (view !== undefined && view.turn.status !== "working")
    return { ...entry, status: "failed", error: MISSED_STEER };

  return entry;
};

/**
 * The outbox against the conversation: steers that landed and follow-ups whose
 * Turn started drop out; a steer whose Turn ended without it fails. The same
 * array when nothing changed.
 */
export const settleOutbox = <A extends OutboxAttachment>(
  outbox: ReadonlyArray<Outgoing<A>>,
  turns: ReadonlyArray<TurnView>
): ReadonlyArray<Outgoing<A>> => {
  const used = new Map<string, number>();
  let changed = false;

  const next = outbox.flatMap((entry) => {
    const settled =
      entry.kind === "steer"
        ? settleSteer(entry, turns, used)
        : entry.status === "sent" && turns.length > entry.baseline
          ? null
          : entry;

    if (settled !== entry) changed = true;

    return settled === null ? [] : [settled];
  });

  return changed ? next : outbox;
};

/** The follow-up to send now that the session takes a Turn: the first waiting, one at a time. */
export const nextQueued = <A extends OutboxAttachment>(
  outbox: ReadonlyArray<Outgoing<A>>
): Outgoing<A> | null => {
  const busy = outbox.some(
    (e) => e.kind === "queued" && (e.status === "sending" || e.status === "sent")
  );

  return busy ? null : (outbox.find((e) => e.kind === "queued" && e.status === "waiting") ?? null);
};
