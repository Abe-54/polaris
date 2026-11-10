/**
 * The Turn rail (DESIGN.md, Turn rail; Paper 8, 8b): one tick per shown Turn (a user Turn
 * with the Turns the Harness started after it, `turnGroups.ts`) down the
 * conversation's right edge from three Turns on. Ticks near the pointer lengthen
 * in an arc; the Turns in view are darker. Pure, so the arc and the hit test are tested.
 */
import type { TurnView } from "../../../store/sessionModel.ts";
import { type Row, summarize, turnOpening } from "./conversation.ts";
import { groupTurns, openingView, sameViews, type TurnGroup } from "./turnGroups.ts";

/** The rail shows from this many Turns. */
export const RAIL_MIN_TURNS = 3;

/** Px between ticks when they fit; closer when they don't, never under `MIN_PITCH`. */
export const PITCH = 8;

const MIN_PITCH = 3;

/** A tick's length at rest and at the pointer; the arc steps down over three neighbours. */
export const REST = 8;

export const LONGEST = 22;

const ARC = [22, 19, 16, 13];

export interface RailTurn {
  readonly turnId: string;
  readonly number: number;
  readonly startedAt: string;
  /** What started it: the prompt, or what woke a Turn the Harness started. */
  readonly opening: string;
  readonly files: number;
}

interface Cached {
  readonly views: ReadonlyArray<TurnView>;
  readonly number: number;
  readonly turn: RailTurn;
}

const cache = new WeakMap<TurnView, Cached>();

/** A group's tick; the same object while its Turns are unchanged, so only the live one is redone. */
const railTurn = (group: TurnGroup): RailTurn => {
  const opening = openingView(group);
  const hit = cache.get(opening);

  if (hit !== undefined && hit.number === group.number && sameViews(hit.views, group.views))
    return hit.turn;
  const { turnId, number, files, startedAt } = summarize(group);
  const turn = { turnId, number, startedAt, opening: turnOpening(opening.turn), files };

  cache.set(opening, { views: group.views, number: group.number, turn });

  return turn;
};

export const railTurns = (turns: ReadonlyArray<TurnView>): ReadonlyArray<RailTurn> =>
  groupTurns(turns).map(railTurn);

/** How many ticks fit in `height`, and their pitch: past that, each tick stands for a band of Turns. */
export const railLayout = (count: number, height: number) => {
  const ticks = Math.max(1, Math.min(count, Math.floor(height / MIN_PITCH)));
  const pitch = Math.min(PITCH, height / ticks);

  return { ticks, pitch, height: ticks * pitch };
};

/** The first Turn a tick stands for. */
export const tickTurn = (tick: number, ticks: number, count: number) =>
  Math.floor((tick * count) / ticks);

/** The Turn under a point `y` px down a rail `height` px tall. */
export const turnAt = (y: number, height: number, count: number) =>
  Math.min(count - 1, Math.max(0, Math.floor((y / height) * count)));

/** A tick's length: the arc around the pointed Turn, or only that tick under Reduce Motion. */
export const tickLength = (tick: number, pointed: number | null, still: boolean): number => {
  if (pointed === null) return REST;
  const distance = Math.abs(tick - pointed);

  if (still) return distance === 0 ? LONGEST : REST;

  return ARC[distance] ?? REST;
};

const rowTurn = (row: Row | undefined): string | null =>
  row !== undefined && "turnId" in row ? row.turnId : null;

/** The Turns whose rows are between `start` and `end` (the virtualizer's range), as indices. */
export const turnsInView = (
  rows: ReadonlyArray<Row>,
  start: number,
  end: number,
  turnIndex: ReadonlyMap<string, number>
): { readonly first: number; readonly last: number } | null => {
  let first: number | null = null;
  let last: number | null = null;

  for (let i = Math.max(0, start); i <= Math.min(end, rows.length - 1); i++) {
    const id = rowTurn(rows[i]);
    const at = id === null ? undefined : turnIndex.get(id);

    if (at === undefined) continue;
    first ??= at;
    last = at;
  }

  return first === null || last === null ? null : { first, last };
};
