/**
 * Steers the thread doesn't show yet: sent into the Turn in flight, waiting
 * for its Harness to take them in (the Turn's `UserMessage` item). Each shows
 * in the thread while it waits, and stays with the reason when it doesn't land.
 */
import type { Attachment } from "@polaris/protocol";
import { Predicate } from "effect";
import type { TurnEntry } from "./fold.ts";

export type SteerStatus =
  /** Dispatched; the Host hasn't answered yet. */
  | "sending"
  /** The Host took it; waiting for the Harness to take it in. */
  | "sent"
  | "failed";

export interface OutgoingSteer {
  readonly id: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<Attachment>;
  readonly turnId: string;
  /** The Turn's user messages when it was sent: it lands past them. */
  readonly baseline: number;
  readonly status: SteerStatus;
  /** Why it failed, as the user reads it. */
  readonly error: string | null;
}

/** Said when a steer's Turn ended without the Harness reporting it. */
export const MISSED_STEER = "The turn ended before it landed";

/** The user messages (landed steers) of a Turn, in order. */
export const steersOf = (entry: TurnEntry | undefined): ReadonlyArray<string> =>
  entry === undefined
    ? []
    : [...entry.items, ...entry.live].flatMap((item) =>
        Predicate.isTagged(item, "UserMessage") ? [item.text.trim()] : []
      );

let counter = 0;

export const outgoingSteer = (
  turns: ReadonlyArray<TurnEntry>,
  turnId: string,
  text: string,
  attachments: ReadonlyArray<Attachment> = []
): OutgoingSteer => {
  counter += 1;

  return {
    id: `steer-${counter}`,
    text: text.trim(),
    attachments,
    turnId,
    baseline: steersOf(turns.find((entry) => entry.turn.id === turnId)).length,
    status: "sending",
    error: null,
  };
};

/**
 * The outbox against the thread: a steer that landed drops out, one whose Turn
 * ended without it fails. The same array when nothing changed.
 */
export const settleSteers = (
  outbox: ReadonlyArray<OutgoingSteer>,
  turns: ReadonlyArray<TurnEntry>
): ReadonlyArray<OutgoingSteer> => {
  const used = new Map<string, number>();
  let changed = false;

  const next = outbox.flatMap((entry): ReadonlyArray<OutgoingSteer> => {
    if (entry.status !== "sent") return [entry];
    const turn = turns.find((held) => held.turn.id === entry.turnId);
    const from = Math.max(entry.baseline, used.get(entry.turnId) ?? 0);
    const at = steersOf(turn).findIndex((text, n) => n >= from && text === entry.text);
    changed ||= at !== -1 || (turn !== undefined && turn.turn.status !== "working");

    if (at !== -1) {
      used.set(entry.turnId, at + 1);

      return [];
    }

    return turn !== undefined && turn.turn.status !== "working"
      ? [{ ...entry, status: "failed", error: MISSED_STEER }]
      : [entry];
  });

  return changed ? next : outbox;
};
