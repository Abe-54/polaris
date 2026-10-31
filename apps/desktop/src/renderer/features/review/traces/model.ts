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

/** A side of the comparison: the Turn Review shows as "turn 23", and its last Turn's id. */
export interface CompareSide {
  readonly turnId: TurnId;
  readonly number: number;
}

/** The Turns compared; `before` is null when no earlier Turn exists to compare with. */
export interface ComparePlan {
  readonly before: CompareSide | null;
  readonly after: CompareSide;
}

/** A Review Turn's traces are its last Turn's: where the code it left ran last. */
const sideOf = (turn: ReviewTurn): CompareSide => ({
  turnId: turn.turns.at(-1)?.id ?? turn.id,
  number: turn.number,
});

/** The Turn before the first one under review; the session's first when that is the first. */
const baselineOf = (turns: ReadonlyArray<ReviewTurn>, pending: ReadonlyArray<ReviewTurn>) => {
  const first = turns.findIndex((t) => t.id === pending[0]?.id);

  return first > 0 ? turns[first - 1] : turns[0];
};

/**
 * One Turn picked: it against the Turn before it. Across the session: the latest Turn
 * against the one before those under review (the last accepted), else the session's first.
 */
export const comparePlan = (
  turns: ReadonlyArray<ReviewTurn>,
  pending: ReadonlyArray<ReviewTurn>,
  pick: TurnPick
): ComparePlan | null => {
  if (pick.kind === "turn") {
    const at = turns.findIndex((t) => t.id === pick.turnId);
    const turn = turns[at];
    const previous = turns[at - 1];

    if (turn === undefined) return null;

    return { before: previous === undefined ? null : sideOf(previous), after: sideOf(turn) };
  }

  const last = turns.at(-1);
  const baseline = baselineOf(turns, pending);

  if (last === undefined) return null;

  return {
    before: baseline === undefined || baseline === last ? null : sideOf(baseline),
    after: sideOf(last),
  };
};

const turnSelector = (side: CompareSide): TraceCompareSelector =>
  TraceCompareSelector.cases.Turn.make({ turnId: side.turnId });

/** `traces.compare`'s a and b; with no earlier Turn, the Turn against itself (before unused). */
export const selectors = (plan: ComparePlan) => ({
  a: turnSelector(plan.before ?? plan.after),
  b: turnSelector(plan.after),
});

/** "Turn 23 against turn 22", or that there is nothing earlier to compare with. */
export const compareCaption = (plan: ComparePlan) =>
  plan.before === null
    ? `Turn ${plan.after.number} · no earlier turn to compare with`
    : `Turn ${plan.after.number} against turn ${plan.before.number}`;

export type RouteChange = "compared" | "no-baseline" | "not-run";

export interface RouteRow {
  readonly key: string;
  readonly service: string;
  readonly route: string;
  readonly change: RouteChange;
  /** Null when there is no baseline: no earlier Turn, or the route didn't run in it. */
  readonly before: TraceRouteStats | null;
  readonly after: TraceRouteStats;
  /** after p50 over before p50, when both ran. */
  readonly ratio: number | null;
}

const ratioOf = (before: TraceRouteStats | null, after: TraceRouteStats) =>
  before === null || before.p50Ms === null || after.p50Ms === null || before.p50Ms === 0
    ? null
    : after.p50Ms / before.p50Ms;

const changeOf = (before: TraceRouteStats | null, after: TraceRouteStats): RouteChange => {
  if (before === null) return "no-baseline";

  return after.count === 0 ? "not-run" : "compared";
};

const RANK: Record<RouteChange, number> = { compared: 0, "no-baseline": 1, "not-run": 2 };

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

      return {
        key: `${r.service}\u0000${r.route}`,
        service: r.service,
        route: r.route,
        change: changeOf(before, r.after),
        before,
        after: r.after,
        ratio: ratioOf(before, r.after),
      };
    })
    .filter((r) => r.before !== null || r.after.count > 0)
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

/** The files list's figure for a route. */
export const listFigure = (row: RouteRow) => {
  if (row.change === "no-baseline") return "no baseline";

  if (row.change === "not-run") return `${duration(row.before?.p50Ms ?? null)} → not run`;

  return arrowFigure(row.before?.p50Ms ?? null, row.after.p50Ms);
};

/** The body's p50 cell: "122 ms → 840 ms", "212 ms" (its "no baseline" sits beside it). */
export const p50Line = (row: RouteRow) => {
  if (row.change === "no-baseline") return duration(row.after.p50Ms);

  if (row.change === "not-run") return `${duration(row.before?.p50Ms ?? null)} → not run`;

  return `${duration(row.before?.p50Ms ?? null)} → ${duration(row.after.p50Ms)}`;
};

const runs = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "run" : "runs"}`;

/** "3 → 5 runs", or the later Turn's runs alone without a baseline. */
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
    `p50 ${row.change === "no-baseline" ? `${p50Line(row)}, no baseline` : p50Line(row)}`,
    runsLine(row),
  ].join(" · ");

/** The Turn whose traces a row opens: the later one, or the earlier when it didn't run then. */
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

/** What the section knows: the routes, or why it can't say. */
export type TracesAnswer =
  | { readonly status: "ready"; readonly rows: ReadonlyArray<RouteRow>; readonly caption: string }
  | { readonly status: "failed"; readonly message: string };

const routesWord = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "route" : "routes"}`;

/** "Traces", its Route timings row, then the first routes; nothing when no route ran. */
export const tracesListRows = (answer: TracesAnswer): ReadonlyArray<TracesListRow> => {
  const head = { kind: "traces-head", key: "traces" } as const;

  if (answer.status === "failed")
    return [
      head,
      {
        kind: "traces-compare",
        key: "traces:compare",
        figure: "unavailable",
        title: answer.message,
      },
    ];

  if (answer.rows.length === 0) return [];

  return [
    head,
    {
      kind: "traces-compare",
      key: "traces:compare",
      figure: routesWord(answer.rows.length),
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
