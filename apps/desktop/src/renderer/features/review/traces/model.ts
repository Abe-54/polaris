/**
 * Review's Traces section (DESIGN.md, Traces → In Review; ENG-660): which two Turns it
 * compares, its routes in the order a reviewer needs them, and the words and figures each
 * row shows. Pure, so tested.
 */
import {
  TraceCompareSelector,
  type TraceComparison,
  type TraceRouteStats,
  type TurnId,
} from "@polaris/protocol";
import type { ReviewTurn, TurnPick } from "../data/source.ts";
import { formatDuration } from "../../traces/model/format.ts";

/**
 * A side of the comparison: its Turns, oldest first, and the Review Turn it shows as "turn 23";
 * `number` is null for Baseline's earlier Turns.
 */
export interface CompareSide {
  readonly turnIds: readonly [TurnId, ...TurnId[]];
  readonly number: number | null;
}

/** The Turns compared; `before` is null when no earlier Turn exists to compare with. */
export interface ComparePlan {
  readonly before: CompareSide | null;
  readonly after: CompareSide & { readonly number: number };
}

const nonEmpty = (ids: ReadonlyArray<TurnId>): CompareSide["turnIds"] | null => {
  const [first, ...rest] = ids;

  return first === undefined ? null : [first, ...rest];
};

/** A Review Turn's traces are those of all its Turns: the user's Turn and its continuations. */
const sideOf = (turn: ReviewTurn) => ({
  turnIds: nonEmpty(turn.turns.map((t) => t.id)) ?? [turn.id],
  number: turn.number,
});

/** The Turn before the first one under review; the session's first when that is the first. */
const baselineOf = (turns: ReadonlyArray<ReviewTurn>, pending: ReadonlyArray<ReviewTurn>) => {
  const first = turns.findIndex((t) => t.id === pending[0]?.id);

  return first > 0 ? turns[first - 1] : turns[0];
};

/**
 * One Turn picked: it against every earlier Turn (Baseline). Across the session: the latest
 * Turn against the one before those under review (the last accepted), else the session's first.
 */
export const comparePlan = (
  turns: ReadonlyArray<ReviewTurn>,
  pending: ReadonlyArray<ReviewTurn>,
  pick: TurnPick
): ComparePlan | null => {
  if (pick.kind === "turn") {
    const at = turns.findIndex((t) => t.id === pick.turnId);
    const turn = turns[at];

    if (turn === undefined) return null;
    const earlier = nonEmpty(turns.slice(0, at).flatMap((t) => sideOf(t).turnIds));

    return {
      before: earlier === null ? null : { turnIds: earlier, number: null },
      after: sideOf(turn),
    };
  }

  const last = turns.at(-1);
  const baseline = baselineOf(turns, pending);

  if (last === undefined) return null;

  return {
    before: baseline === undefined || baseline === last ? null : sideOf(baseline),
    after: sideOf(last),
  };
};

/** One Turn as Turn, which every Daemon with `traces.compare` reads; several as a range. */
const sideSelector = ({ turnIds }: CompareSide): TraceCompareSelector => {
  const [first] = turnIds;
  const last = turnIds.at(-1) ?? first;

  return first === last
    ? TraceCompareSelector.cases.Turn.make({ turnId: first })
    : TraceCompareSelector.cases.Turns.make({ firstTurnId: first, lastTurnId: last });
};

/** `traces.compare`'s a and b; with no earlier Turn, the Turn against itself (before unused). */
export const selectors = (plan: ComparePlan) => ({
  a:
    plan.before === null
      ? sideSelector(plan.after)
      : plan.before.number === null
        ? TraceCompareSelector.cases.Baseline.make({})
        : sideSelector(plan.before),
  b: sideSelector(plan.after),
});

/** "Turn 23 against earlier turns", "Turn 23 against turn 22", or nothing to compare with. */
export const compareCaption = (plan: ComparePlan) => {
  if (plan.before === null) return `Turn ${plan.after.number} · no earlier turn to compare with`;

  return plan.before.number === null
    ? `Turn ${plan.after.number} against earlier turns`
    : `Turn ${plan.after.number} against turn ${plan.before.number}`;
};

/** Which side's traces a row opens, in words: "turn 23", "earlier turns". */
export const sideName = (side: CompareSide) =>
  side.number === null ? "earlier turns" : `turn ${side.number}`;

/**
 * compared: both sides have a p50. no-baseline: the Daemon gave no p50 (under 3 runs a side).
 * not-run: no complete run in the later Turn; partial: only partial ones.
 */
export type RouteChange = "compared" | "no-baseline" | "not-run" | "partial";

export interface RouteRow {
  readonly key: string;
  readonly service: string;
  readonly route: string;
  readonly change: RouteChange;
  /** Null when nothing ran earlier: no earlier Turn, or the route didn't run in it. */
  readonly before: TraceRouteStats | null;
  readonly after: TraceRouteStats;
  /** Partial traces in the later Turn, left out of its runs and p50. */
  readonly partial: number;
  /** after p50 over before p50, when both are above 0 ms. */
  readonly ratio: number | null;
}

const ratioOf = (before: TraceRouteStats | null, after: TraceRouteStats) =>
  before === null ||
  before.p50Ms === null ||
  after.p50Ms === null ||
  before.p50Ms <= 0 ||
  after.p50Ms <= 0
    ? null
    : after.p50Ms / before.p50Ms;

const changeOf = (
  before: TraceRouteStats | null,
  after: TraceRouteStats,
  partial: number
): RouteChange => {
  if (after.count === 0) return partial > 0 ? "partial" : "not-run";

  return before === null || before.p50Ms === null || after.p50Ms === null
    ? "no-baseline"
    : "compared";
};

const RANK: Record<RouteChange, number> = {
  compared: 0,
  "no-baseline": 1,
  partial: 2,
  "not-run": 3,
};

/**
 * The routes, biggest slowdown first, then those without a baseline, then those that didn't
 * run in the later Turn; ties keep the Daemon's service-then-route order.
 */
export const routeRows = (
  comparison: TraceComparison,
  plan: ComparePlan
): ReadonlyArray<RouteRow> =>
  comparison.routes
    .map((r): RouteRow => {
      const before = plan.before === null || r.before.count === 0 ? null : r.before;
      const partial = r.partial?.after ?? 0;

      return {
        key: `${r.service}\u0000${r.route}`,
        service: r.service,
        route: r.route,
        change: changeOf(before, r.after, partial),
        before,
        after: r.after,
        partial,
        ratio: ratioOf(before, r.after),
      };
    })
    .filter((r) => r.before !== null || r.after.count > 0 || r.partial > 0)
    .toSorted((x, y) => RANK[x.change] - RANK[y.change] || (y.ratio ?? 0) - (x.ratio ?? 0));

const duration = (ms: number | null) => (ms === null ? "–" : formatDuration(ms));

const UNIT = / (ms|s|min)$/;

/** "122 → 840 ms", "840 ms → 3.1 s": the unit once when both sides share it. */
export const arrowFigure = (before: number | null, after: number | null) => {
  const a = duration(before);
  const b = duration(after);
  const unit = UNIT.exec(a)?.[1];

  return unit !== undefined && unit === UNIT.exec(b)?.[1]
    ? `${a.replace(UNIT, "")} → ${b}`
    : `${a} → ${b}`;
};

/** The later side when the Daemon gave no p50: "not run", "partial" or "no baseline". */
const withoutP50 = (row: RouteRow) => {
  if (row.change === "not-run") return "not run";

  return row.change === "partial" ? "partial" : "no baseline";
};

/** The files list's figure for a route. */
export const listFigure = (row: RouteRow) =>
  row.change === "compared"
    ? arrowFigure(row.before?.p50Ms ?? null, row.after.p50Ms)
    : withoutP50(row);

/** The body's p50 cell: "122 ms → 840 ms", or the word for a route without both p50s. */
export const p50Line = (row: RouteRow) =>
  row.change === "compared"
    ? `${duration(row.before?.p50Ms ?? null)} → ${duration(row.after.p50Ms)}`
    : withoutP50(row);

const runs = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "run" : "runs"}`;

/** "3 → 5 runs", or the later Turn's runs alone when nothing ran earlier. */
export const runsLine = (row: RouteRow) =>
  row.before === null
    ? runs(row.after.count)
    : `${row.before.count.toLocaleString("en-US")} → ${runs(row.after.count)}`;

/** "6.9× slower", "2× faster", "about the same" (within 10%); null without both sides. */
export const changeWord = (row: RouteRow) => {
  if (row.ratio === null) return null;

  if (Math.abs(row.ratio - 1) < 0.1) return "about the same";

  const factor = row.ratio > 1 ? row.ratio : 1 / row.ratio;

  return `${Number(factor.toFixed(1))}× ${row.ratio > 1 ? "slower" : "faster"}`;
};

/** The row's whole sentence, as its tooltip. */
export const routeTitle = (row: RouteRow) =>
  [
    `${row.route} (${row.service})`,
    `p50 ${p50Line(row)}`,
    runsLine(row),
    ...(row.partial > 0 ? [`${row.partial.toLocaleString("en-US")} partial left out`] : []),
  ].join(" · ");

/** The Turns whose traces a row opens: the later ones, or the earlier when it didn't run then. */
export const openTurn = (row: RouteRow, plan: ComparePlan): CompareSide =>
  row.change === "not-run" && plan.before !== null ? plan.before : plan.after;

/** Routes the files list names before "+ N more routes". */
export const LISTED_ROUTES = 5;

/** A row of the files list's Traces section. */
export type TracesListRow =
  | { readonly kind: "traces-head"; readonly key: string }
  | {
      readonly kind: "traces-compare";
      readonly key: string;
      /** "5 routes", "comparing…" or "unavailable". */
      readonly figure: string;
      /** Why it's unavailable, or the caption, as the tooltip. */
      readonly title: string;
    }
  | {
      readonly kind: "traces-route";
      readonly key: string;
      readonly route: string;
      readonly figure: string;
      readonly title: string;
    }
  | { readonly kind: "traces-more"; readonly key: string; readonly count: number };

/**
 * What the section knows: the routes, or why it can't say. `loading` keeps the last answer
 * shown while another pick's comparison is asked.
 */
export type TracesAnswer = (
  | {
      readonly status: "ready";
      readonly rows: ReadonlyArray<RouteRow>;
      readonly caption: string;
    }
  | { readonly status: "failed"; readonly message: string }
) & { readonly loading?: boolean };

const routesWord = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "route" : "routes"}`;

const COMPARING = "comparing…";

/** "Traces", its Route timings row, then the first routes; nothing when no route ran. */
export const tracesListRows = (answer: TracesAnswer): ReadonlyArray<TracesListRow> => {
  const head = { kind: "traces-head", key: "traces" } as const;

  if (answer.status === "failed")
    return [
      head,
      {
        kind: "traces-compare",
        key: "traces:compare",
        figure: answer.loading === true ? COMPARING : "unavailable",
        title: answer.message,
      },
    ];

  if (answer.rows.length === 0) return [];

  return [
    head,
    {
      kind: "traces-compare",
      key: "traces:compare",
      figure: answer.loading === true ? COMPARING : routesWord(answer.rows.length),
      title: answer.caption,
    },
    ...answer.rows.slice(0, LISTED_ROUTES).map((row): TracesListRow => ({
      kind: "traces-route",
      key: `traces:${row.key}`,
      route: row.route,
      figure: listFigure(row),
      title: routeTitle(row),
    })),
    ...(answer.rows.length > LISTED_ROUTES
      ? [
          {
            kind: "traces-more",
            key: "traces:more",
            count: answer.rows.length - LISTED_ROUTES,
          } as const,
        ]
      : []),
  ];
};

const TRACES_KINDS: ReadonlySet<string> = new Set([
  "traces-head",
  "traces-compare",
  "traces-route",
  "traces-more",
]);

export const isTracesRow = (row: { readonly kind: string }): row is TracesListRow =>
  TRACES_KINDS.has(row.kind);
