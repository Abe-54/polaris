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
  compareCaption,
  type ComparePlan,
  comparePlan,
  listFigure,
  openTurn,
  routeRows,
  routeTitle,
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

/** Each side's selector as the Daemon is sent it. */
const sides = (plan: ComparePlan | null) => {
  if (plan === null) return null;
  const { a, b } = selectors(plan);

  return [plan.before === null ? null : a, b];
};

const ALL: TurnPick = { kind: "all" };

const turnPick = (id: string): TurnPick => ({ kind: "turn", turnId: TurnId.make(id) });

const turn = (id: string) => TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make(id) });

const baseline = TraceCompareSelector.cases.Baseline.make({});

const t23 = TraceCompareSelector.cases.Turns.make({
  firstTurnId: TurnId.make("t23"),
  lastTurnId: TurnId.make("t23.1"),
});

describe("which Turns Review compares", () => {
  test.each([
    ["a picked Turn, against every earlier Turn", turnPick("t22"), T, [baseline, turn("t22")]],
    ["a picked Turn of several Turns, as their range", turnPick("t23"), T, [baseline, t23]],
    ["the session's first Turn, with nothing earlier", turnPick("t21"), T, [null, turn("t21")]],
    [
      "the session, against the Turn before those under review",
      ALL,
      T.slice(1),
      [turn("t21"), t23],
    ],
    ["the session with nothing accepted, from its first Turn", ALL, T, [turn("t21"), t23]],
  ] as const)("%s", (_, pick, pending, expected) => {
    expect(sides(comparePlan(T, pending, pick))).toEqual([...expected]);
  });

  test("a session of one Turn has no baseline", () => {
    expect(sides(comparePlan(T.slice(0, 1), T.slice(0, 1), ALL))).toEqual([null, turn("t21")]);
  });

  test("a Turn that isn't the session's compares nothing", () => {
    expect(comparePlan(T, T, turnPick("t99"))).toBeNull();
  });

  test("with no earlier Turn the request compares the Turn with itself", () => {
    const plan = comparePlan(T, T, turnPick("t21"));

    expect(plan === null ? null : selectors(plan)).toEqual({ a: turn("t21"), b: turn("t21") });
  });

  test.each([
    [turnPick("t23"), "Turn 23 against earlier turns"],
    [ALL, "Turn 23 against turn 21"],
    [turnPick("t21"), "Turn 21 · no earlier turn to compare with"],
  ] as const)("%j is captioned %p", (pick, caption) => {
    const plan = comparePlan(T, T, pick);

    expect(plan === null ? null : compareCaption(plan)).toBe(caption);
  });
});

/** A side as the Daemon sends it: a p50 only with at least three runs on both sides. */
const stats = (p50Ms: number | null, count: number): TraceRouteStats => ({
  p50Ms,
  p95Ms: p50Ms,
  count,
});

const comparison = (
  routes: ReadonlyArray<
    readonly [string, TraceRouteStats, TraceRouteStats, { before: number; after: number }?]
  >
): TraceComparison => ({
  a: TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("t22") }),
  b: TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("t23") }),
  routes: routes.map(([route, before, after, partial]) => ({
    service: "api",
    route,
    before,
    after,
    ...(partial === undefined ? undefined : { partial }),
  })),
});

const PLAN: ComparePlan = {
  before: { turnIds: [TurnId.make("t22")], number: 22 },
  after: { turnIds: [TurnId.make("t23")], number: 23 },
};

const ROUTES = comparison([
  ["GET /a faster", stats(100, 3), stats(50, 3)],
  ["GET /b new", stats(null, 0), stats(null, 5)],
  ["GET /c gone", stats(null, 5), stats(null, 0)],
  ["GET /d much slower", stats(10, 4), stats(90, 5)],
  ["GET /e once each", stats(null, 1), stats(null, 1)],
  ["GET /f slower", stats(100, 3), stats(150, 3)],
  ["GET /g trimmed", stats(null, 3), stats(null, 0), { before: 0, after: 2 }],
]);

describe("the routes", () => {
  test("biggest slowdown first, then without a baseline, partial, then those that didn't run", () => {
    expect(routeRows(ROUTES, PLAN).map((r) => [r.route, r.change])).toEqual([
      ["GET /d much slower", "compared"],
      ["GET /f slower", "compared"],
      ["GET /a faster", "compared"],
      ["GET /b new", "no-baseline"],
      ["GET /e once each", "no-baseline"],
      ["GET /g trimmed", "partial"],
      ["GET /c gone", "not-run"],
    ]);
  });

  test("with no earlier Turn every route that ran has no baseline, and nothing else shows", () => {
    const rows = routeRows(ROUTES, { before: null, after: PLAN.after });

    expect(rows.map((r) => [r.route, r.change, r.before])).toEqual([
      ["GET /a faster", "no-baseline", null],
      ["GET /b new", "no-baseline", null],
      ["GET /d much slower", "no-baseline", null],
      ["GET /e once each", "no-baseline", null],
      ["GET /f slower", "no-baseline", null],
      ["GET /g trimmed", "partial", null],
    ]);
  });

  test("a route that didn't run in the later Turn opens the earlier Turn's traces", () => {
    const rows = routeRows(ROUTES, PLAN);

    expect(rows.map((r) => openTurn(r, PLAN).number)).toEqual([23, 23, 23, 23, 23, 23, 22]);
  });

  test.each([
    ["GET /d much slower", "10 → 90 ms", "4 → 5 runs", "9× slower"],
    ["GET /a faster", "100 → 50 ms", "3 → 3 runs", "2× faster"],
    ["GET /b new", "no baseline", "5 runs", null],
    ["GET /e once each", "no baseline", "1 → 1 run", null],
    ["GET /c gone", "not run", "5 → 0 runs", null],
    ["GET /g trimmed", "partial", "3 → 0 runs", null],
  ])("%s reads %p, %p, %p", (route, figure, runs, change) => {
    const row = routeRows(ROUTES, PLAN).find((r) => r.route === route);

    expect(row === undefined ? null : [listFigure(row), runsLine(row), changeWord(row)]).toEqual([
      figure,
      runs,
      change,
    ]);
  });

  test("no row reads the '–' placeholder the Daemon's null p50 used to give", () => {
    const titles = routeRows(ROUTES, PLAN).map((row) => routeTitle(row));

    expect(titles.filter((title) => title.includes("–"))).toEqual([]);
  });

  test("partial runs left out are named in the row's sentence", () => {
    const row = routeRows(ROUTES, PLAN).find((r) => r.route === "GET /g trimmed");

    expect(row === undefined ? null : routeTitle(row)).toBe(
      "GET /g trimmed (api) · p50 partial · 3 → 0 runs · 2 partial left out"
    );
  });

  test("within 10% reads about the same", () => {
    const [row] = routeRows(comparison([["GET /x", stats(100, 3), stats(105, 3)]]), PLAN);

    expect(row === undefined ? null : changeWord(row)).toBe("about the same");
  });

  test.each([
    [5, 0],
    [0, 5],
  ])("a p50 of %p → %p ms has no change word rather than an infinite or zero factor", (a, b) => {
    const [row] = routeRows(comparison([["GET /x", stats(a, 3), stats(b, 3)]]), PLAN);

    expect(row === undefined ? null : [row.change, changeWord(row)]).toEqual(["compared", null]);
  });

  test.each([
    [122, 840, "122 → 840 ms"],
    [840, 3100, "840 ms → 3.1 s"],
    [1400, 3100, "1.4 → 3.1 s"],
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
    expect(list[1]).toMatchObject({ figure: "14 routes", title: caption });
    expect(list.at(-1)).toMatchObject({ count: 9 });
  });

  test("no route ran in either Turn: no section", () => {
    expect(tracesListRows({ status: "ready", rows: [], caption })).toEqual([]);
  });

  test("while another pick is compared the last routes stay, and Route timings says comparing", () => {
    const list = tracesListRows({
      status: "ready",
      rows: routeRows(ROUTES, PLAN),
      caption,
      loading: true,
    });

    expect(list.map((r) => r.kind).slice(0, 3)).toEqual([
      "traces-head",
      "traces-compare",
      "traces-route",
    ]);
    expect(list[1]).toMatchObject({ figure: "comparing…" });
  });

  test("a failed comparison says unavailable, with the Daemon's reason as the tooltip", () => {
    const list = tracesListRows({ status: "failed", message: "No turn t22 in this session" });

    expect(list[1]).toMatchObject({ figure: "unavailable", title: "No turn t22 in this session" });
  });
});
