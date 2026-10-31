import { describe, expect, test } from "bun:test";
import {
  TraceCompareSelector,
  type TraceComparison,
  type TraceRouteStats,
  TurnId,
} from "@polaris/protocol";
import type { ReviewTurn, TurnPick } from "../data/source.ts";
import {
  arrowFigure,
  changeWord,
  type ComparePlan,
  comparePlan,
  listFigure,
  openTurn,
  routeRows,
  runsLine,
  selectors,
  tracesListRows,
} from "./model.ts";

const reviewTurn = (number: number, extra = 0): ReviewTurn => ({
  id: TurnId.make(`t${number}`),
  number,
  prompt: `turn ${number}`,
  turns: Array.from({ length: extra + 1 }, (_, i) => ({
    id: TurnId.make(i === 0 ? `t${number}` : `t${number}.${i}`),
    index: number * 10 + i,
    prompt: "",
    checkpointBefore: null,
    checkpointAfter: null,
    status: "completed",
  })),
});

const T = [reviewTurn(21), reviewTurn(22), reviewTurn(23, 1)];

const sides = (plan: ComparePlan | null): ReadonlyArray<string | null> | null =>
  plan === null ? null : [plan.before?.turnId ?? null, plan.after.turnId];

const ALL: TurnPick = { kind: "all" };

const turnPick = (id: string): TurnPick => ({ kind: "turn", turnId: TurnId.make(id) });

describe("which Turns Review compares", () => {
  test.each([
    ["a picked Turn, against the one before it", turnPick("t22"), T, ["t21", "t22"]],
    ["the session's first Turn, with nothing earlier", turnPick("t21"), T, [null, "t21"]],
    ["the session, against the Turn before those under review", ALL, T.slice(1), ["t21", "t23.1"]],
    ["the session with nothing accepted, from its first Turn", ALL, T, ["t21", "t23.1"]],
  ] as const)("%s", (_, pick, pending, expected) => {
    expect(sides(comparePlan(T, pending, pick))).toEqual(expected);
  });

  test("a session of one Turn has no baseline", () => {
    expect(sides(comparePlan(T.slice(0, 1), T.slice(0, 1), ALL))).toEqual([null, "t21"]);
  });

  test("a Turn that isn't the session's compares nothing", () => {
    expect(comparePlan(T, T, turnPick("t99"))).toBeNull();
  });

  test("with no earlier Turn the request compares the Turn with itself", () => {
    const plan = comparePlan(T, T, turnPick("t21"));

    expect(plan === null ? null : selectors(plan)).toEqual({
      a: TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("t21") }),
      b: TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("t21") }),
    });
  });
});

const stats = (p50Ms: number | null, count: number): TraceRouteStats => ({
  p50Ms,
  p95Ms: p50Ms,
  count,
});

const comparison = (
  routes: ReadonlyArray<readonly [string, TraceRouteStats, TraceRouteStats]>
): TraceComparison => ({
  a: TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("t22") }),
  b: TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("t23") }),
  routes: routes.map(([route, before, after]) => ({ service: "api", route, before, after })),
});

const PLAN: ComparePlan = {
  before: { turnId: TurnId.make("t22"), number: 22 },
  after: { turnId: TurnId.make("t23"), number: 23 },
};

const ROUTES = comparison([
  ["GET /a faster", stats(100, 3), stats(50, 3)],
  ["GET /b new", stats(null, 0), stats(212, 1)],
  ["GET /c gone", stats(122, 2), stats(null, 0)],
  ["GET /d much slower", stats(10, 4), stats(90, 5)],
  ["GET /e slower", stats(100, 1), stats(150, 1)],
]);

describe("the routes", () => {
  test("biggest slowdown first, then without a baseline, then those that didn't run", () => {
    expect(routeRows(ROUTES, PLAN).map((r) => [r.route, r.change])).toEqual([
      ["GET /d much slower", "compared"],
      ["GET /e slower", "compared"],
      ["GET /a faster", "compared"],
      ["GET /b new", "no-baseline"],
      ["GET /c gone", "not-run"],
    ]);
  });

  test("with no earlier Turn every route that ran has no baseline, and nothing else shows", () => {
    const rows = routeRows(ROUTES, { before: null, after: PLAN.after });

    expect(rows.map((r) => [r.route, r.change, r.before])).toEqual([
      ["GET /a faster", "no-baseline", null],
      ["GET /b new", "no-baseline", null],
      ["GET /d much slower", "no-baseline", null],
      ["GET /e slower", "no-baseline", null],
    ]);
  });

  test("a route that didn't run in the later Turn opens the earlier Turn's traces", () => {
    const rows = routeRows(ROUTES, PLAN);

    expect(rows.map((r) => openTurn(r, PLAN).number)).toEqual([23, 23, 23, 23, 22]);
  });

  test.each([
    ["GET /d much slower", "10 → 90 ms", "4 → 5 runs", "9× slower"],
    ["GET /a faster", "100 → 50 ms", "3 → 3 runs", "2× faster"],
    ["GET /b new", "no baseline", "1 run", null],
    ["GET /c gone", "122 ms → not run", "2 → 0 runs", null],
  ])("%s reads %p, %p, %p", (route, figure, runs, change) => {
    const row = routeRows(ROUTES, PLAN).find((r) => r.route === route);

    expect(row === undefined ? null : [listFigure(row), runsLine(row), changeWord(row)]).toEqual([
      figure,
      runs,
      change,
    ]);
  });

  test("within 10% reads about the same", () => {
    const [row] = routeRows(comparison([["GET /x", stats(100, 2), stats(105, 2)]]), PLAN);

    expect(row === undefined ? null : changeWord(row)).toBe("about the same");
  });

  test.each([
    [122, 840, "122 → 840 ms"],
    [840, 3100, "840 ms → 3.1 s"],
    [1400, 3100, "1.4 → 3.1 s"],
    [null, 38, "– → 38 ms"],
  ])("%p → %p is written %p", (before, after, expected) => {
    expect(arrowFigure(before, after)).toBe(expected);
  });
});

describe("the files list's Traces section", () => {
  const caption = "Turn 23 against turn 22";

  test("the kicker, Route timings with the route count, five routes, then the rest folded", () => {
    const rows = [...routeRows(ROUTES, PLAN), ...routeRows(ROUTES, PLAN)].map((r, i) => ({
      ...r,
      key: `${r.key}${i}`,
    }));

    const list = tracesListRows({ status: "ready", rows, caption });

    expect(list.map((r) => r.kind)).toEqual([
      "traces-head",
      "traces-compare",
      ...Array.from({ length: 5 }, () => "traces-route" as const),
      "traces-more",
    ]);
    expect(list[1]).toMatchObject({ figure: "10 routes", title: caption });
    expect(list.at(-1)).toMatchObject({ count: 5 });
  });

  test("no route ran in either Turn: no section", () => {
    expect(tracesListRows({ status: "ready", rows: [], caption })).toEqual([]);
  });

  test("a failed comparison says unavailable, with the Daemon's reason as the tooltip", () => {
    const list = tracesListRows({ status: "failed", message: "No turn t22 in this session" });

    expect(list[1]).toMatchObject({ figure: "unavailable", title: "No turn t22 in this session" });
  });
});
