/**
 * Turns as the Desktop App shows them (owner, 2026-10-19): a Turn runs from one user
 * message to the next, so a Turn the Harness started itself (background tasks reported)
 * folds into the Turn before it. The Daemon's Turns, checkpoints and events are unchanged;
 * only the UI groups them. A Harness-started Turn with no Turn before it stands alone.
 */
import type { Turn, TurnId, TurnItem } from "@polaris/protocol";
import { Predicate } from "effect";
import type { TurnView } from "../../../store/sessionModel.ts";
import { isIdleCompaction } from "./idleCompaction.ts";
import { completedItemView, turnOutput } from "./items.ts";

/** One Turn as the UI shows it: the user's Turn, then each Turn the Harness started after it. */
export interface TurnGroup {
  /** Its first Turn's id: folds, find, the rail and Output key the group by it. */
  readonly id: TurnId;
  /** One-based, as the UI numbers Turns. */
  readonly number: number;
  /** In order, never empty: the opening Turn first. */
  readonly views: ReadonlyArray<TurnView>;
}

/** The first and last Turn a group covers: its diff runs from one's checkpoint to the other's. */
export interface TurnSpan {
  readonly first: TurnId;
  readonly last: TurnId;
}

/** A Turn begun without the user: the Harness's (`Turn.trigger`) or idle compaction's. */
export const harnessStarted = (turn: Turn): boolean =>
  turn.trigger !== null || isIdleCompaction(turn);

/** Whether two groups hold the same Turn views, in order: a cached row or tick still stands. */
export const sameViews = (a: ReadonlyArray<TurnView>, b: ReadonlyArray<TurnView>) =>
  a.length === b.length && a.every((v, n) => v === b[n]);

const cache = new WeakMap<ReadonlyArray<TurnView>, ReadonlyArray<TurnGroup>>();

/**
 * The Turns, grouped; the same array for the same `views`. A group takes its opening Turn's
 * `userTurnNumber`, exact before older pages load; from older Daemons, Turns not loaded yet
 * count as one Turn each, so numbers are exact once the history is listed.
 */
export const groupTurns = (views: ReadonlyArray<TurnView>): ReadonlyArray<TurnGroup> => {
  const hit = cache.get(views);

  if (hit !== undefined) return hit;
  const base = views[0]?.turn.index ?? 0;
  const groups: Array<{ id: TurnId; number: number; views: Array<TurnView> }> = [];

  for (const view of views) {
    const open = groups.at(-1);

    if (open !== undefined && harnessStarted(view.turn)) open.views.push(view);
    else {
      const number = view.turn.userTurnNumber ?? base + groups.length + 1;

      groups.push({ id: view.turn.id, number, views: [view] });
    }
  }

  cache.set(views, groups);

  return groups;
};

/**
 * The first Turn listed was started by the Harness and older Turns aren't listed yet: its user
 * Turn is on an older page, so that page is fetched at once rather than show it as a Turn.
 */
export const continuesOlder = (views: ReadonlyArray<TurnView>): boolean => {
  const first = views[0]?.turn;

  return first !== undefined && first.index > 0 && harnessStarted(first);
};

/** The group a Turn is in, by any of its Turns' ids. */
export const groupOf = (
  groups: ReadonlyArray<TurnGroup>,
  turnId: string | null
): TurnGroup | undefined =>
  turnId === null ? undefined : groups.find((g) => g.views.some((v) => v.turn.id === turnId));

/** The number the UI shows for the Turn `turnId` is in; null when it isn't listed. */
export const turnNumber = (views: ReadonlyArray<TurnView>, turnId: string | null): number | null =>
  groupOf(groupTurns(views), turnId)?.number ?? null;

/** The group's first and last Turn. */
export const groupSpan = (group: TurnGroup): TurnSpan => ({
  first: group.id,
  last: group.views.at(-1)?.turn.id ?? group.id,
});

/** The Turn that opens the group: the user's, or a Harness-started one with none before it. */
export const openingView = (group: TurnGroup): TurnView =>
  // SAFETY: `groupTurns` never makes an empty group.
  group.views[0] as TurnView;

/** The group's last Turn, the one that may still run. */
export const lastView = (group: TurnGroup): TurnView =>
  // SAFETY: `groupTurns` never makes an empty group.
  group.views.at(-1) as TurnView;

/** Every finished item across a shown Turn, its Harness-started Turns' included. */
export const shownItems = (group: TurnGroup): ReadonlyArray<TurnItem> =>
  group.views.flatMap((v) => v.items);

/**
 * "Copy turn output" on a row of the group: every reply across it, a blank line apart; null while
 * it runs, without replies, or when its one reply is the row's own `message` (Copy message has it).
 */
export const copyableOutput = (
  group: TurnGroup,
  message: string | null,
  live: boolean
): string | null => {
  const items = shownItems(group);
  const replies = items.filter((item) => Predicate.isTagged(item, "AssistantMessage")).length;

  if (live || replies === 0 || (message !== null && replies < 2)) return null;

  return turnOutput(items.map(completedItemView));
};
