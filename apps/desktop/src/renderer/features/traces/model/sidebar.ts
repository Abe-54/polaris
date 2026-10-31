/**
 * The sidebar's logic (DESIGN.md, Traces → Sidebar): the filter well's words as a TraceFilter, and
 * the listed traces under Turn kickers, newest first.
 */
import type { TraceFilter, TraceSummary, TraceTurn } from "@polaris/protocol";

const ROUTE_MAX = 256;

const DURATION = /^(?:>=?|min:|duration:>=?)(\d+(?:\.\d+)?)(ms|s)?$/;

const minMs = (word: string): number | null => {
  const match = DURATION.exec(word);

  if (match === null) return null;

  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
};

const STATUS = new Set(["ok", "error"]);

const isStatus = (value: string): value is "ok" | "error" => STATUS.has(value);

type Mutable<A> = { -readonly [K in keyof A]: A[K] };

/** One `key:value` word into `filter`; false when it isn't one the well knows. */
const keyed = (word: string, filter: Mutable<TraceFilter>): boolean => {
  const colon = word.indexOf(":");
  const key = word.slice(0, colon).toLowerCase();
  const value = word.slice(colon + 1);

  if (colon <= 0 || value === "") return false;

  // A root is named "POST /invoices/overdue", so a path matches after the method.
  if (key === "route")
    filter.route = (value.startsWith("/") ? `*${value}` : value).slice(0, ROUTE_MAX);
  else if (key === "service") filter.service = value;
  else if (key === "status" && isStatus(value.toLowerCase()))
    filter.status = value.toLowerCase() === "error" ? "error" : "ok";
  else return false;

  return true;
};

/**
 * `route:/invoices* service:fx-rates status:error >100ms`; other words search the root's name,
 * as `*words*`. An empty well is no filter.
 */
export const parseTraceFilter = (text: string): TraceFilter | undefined => {
  const filter: Mutable<TraceFilter> = {};
  const loose: Array<string> = [];

  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    const min = minMs(word);

    if (min !== null) filter.minMs = min;
    else if (!keyed(word, filter)) loose.push(word);
  }

  if (loose.length > 0 && filter.route === undefined)
    filter.route = `*${loose.join(" ")}*`.slice(0, ROUTE_MAX);

  return Object.keys(filter).length === 0 ? undefined : filter;
};

export interface TurnGroup<A> {
  /** The Turn's id, or "between:<first item's id>" for a run between Turns. */
  readonly key: string;
  readonly turn: TraceTurn | null;
  readonly items: ReadonlyArray<A>;
}

/**
 * Newest first, as listed: a Turn's items together under its kicker, and each run of items
 * between Turns under its own, where it fell in time.
 */
export const groupItemsByTurn = <
  A extends { readonly id: string; readonly turn: TraceTurn | null },
>(
  items: ReadonlyArray<A>
): ReadonlyArray<TurnGroup<A>> => {
  const groups: Array<{ key: string; turn: TraceTurn | null; items: Array<A> }> = [];
  const byTurn = new Map<string, (typeof groups)[number]>();

  for (const item of items) {
    const last = groups.at(-1);

    if (item.turn === null) {
      if (last !== undefined && last.turn === null) last.items.push(item);
      else groups.push({ key: `between:${item.id}`, turn: null, items: [item] });
      continue;
    }

    const known = byTurn.get(item.turn.id);

    if (known !== undefined) {
      known.items.push(item);
      continue;
    }

    const group = { key: item.turn.id, turn: item.turn, items: [item] };

    byTurn.set(item.turn.id, group);
    groups.push(group);
  }

  return groups;
};

export interface TraceGroup {
  readonly key: string;
  readonly turn: TraceTurn | null;
  readonly traces: ReadonlyArray<TraceSummary>;
}

export const groupByTurn = (traces: ReadonlyArray<TraceSummary>): ReadonlyArray<TraceGroup> =>
  groupItemsByTurn(traces).map(({ key, turn, items }) => ({ key, turn, traces: items }));

/** "TURN 12 · NOW" for the session's latest Turn, "BETWEEN TURNS" for none. */
export const turnKicker = (turn: TraceTurn | null, latest: number | null): string => {
  if (turn === null) return "BETWEEN TURNS";

  return turn.number === latest ? `TURN ${turn.number} · NOW` : `TURN ${turn.number}`;
};

export const tracesLabel = (n: number) => (n === 1 ? "1 trace" : `${n} traces`);

export const profilesLabel = (n: number) => (n === 1 ? "1 profile" : `${n} profiles`);
