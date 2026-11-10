/**
 * The needs you hero (MX-C) as data: which page the pager shows as rows come and go, its kicker,
 * and the next up well under the page.
 */
import { Match } from "effect";
import { age } from "./format.ts";
import type { SessionRow } from "./home.ts";

/** The page the pager showed, by row and by place, so an answered row hands over to its neighbour. */
export interface HeroPage {
  readonly key: string | null;
  readonly index: number;
}

/** Where the pager stands now: the same row if it's still waiting, else the place it left. */
export const pageIndex = (rows: ReadonlyArray<SessionRow>, page: HeroPage): number => {
  const found = rows.findIndex((row) => row.key === page.key);

  if (found >= 0) return found;

  return Math.max(0, Math.min(page.index, rows.length - 1));
};

/** "Needs you · 1 of 2", or plain "Needs you" for one. */
export const heroKicker = (index: number, count: number): string =>
  count > 1 ? `Needs you · ${index + 1} of ${count}` : "Needs you";

/** The page the next up well opens: the one after, wrapping, so the card keeps its height. */
export const nextUpIndex = (index: number, count: number): number | null =>
  count > 1 ? (index + 1) % count : null;

const waitWord = (row: SessionRow): string =>
  row.approval === null
    ? "waiting"
    : Match.value(row.approval.kind).pipe(
        Match.when("question", () => "asks"),
        Match.when("command", () => "command"),
        Match.when("file-change", () => "files"),
        Match.when("tool", () => "tool"),
        Match.when("secret", () => "secret"),
        Match.when("app", () => "app"),
        Match.when("headed-input", () => "headed input"),
        Match.when("computer-use", () => "computer use"),
        Match.exhaustive
      );

/** "asks · 18m": what the next row waits on, and for how long. */
export const nextUpMeta = (row: SessionRow, now: number): string =>
  `${waitWord(row)} · ${age(row.since, now)}`;
