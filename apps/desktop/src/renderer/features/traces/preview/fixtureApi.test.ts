import { describe, expect, test } from "bun:test";
import { TraceCompareSelector, TurnId } from "@polaris/protocol";
import { findTrace, fixtureComparison, fixtureSnapshot, nearestRank } from "./fixtureApi.ts";
import { BIG_TRACE, FIXTURE_DETAILS } from "./fixtures.ts";

const roots = (filter: Parameters<typeof fixtureSnapshot>[1]) =>
  fixtureSnapshot("traces", filter).traces.map((t) => t.root);

describe("the fixture traces.watch", () => {
  test("lists newest first, and a limit keeps the full count in total", () => {
    const all = fixtureSnapshot("traces");
    const two = fixtureSnapshot("traces", { limit: 2 });
    const starts = all.traces.map((t) => BigInt(t.startTimeUnixNano));

    expect(starts).toEqual(starts.toSorted((a, b) => (a > b ? -1 : a < b ? 1 : 0)));
    expect([two.traces.length, two.total]).toEqual([2, FIXTURE_DETAILS.length]);
  });

  test.each([
    [{ turn: null }, ["GET /invoices"]],
    [
      { turn: TurnId.make("t-overdue-11") },
      ["settlements.run", "POST /invoices/overdue", "test overdue-totals"],
    ],
    [{ status: "error" as const }, ["test overdue-totals", "settlements.run"]],
    [
      { route: "POST /invoices/*" },
      ["POST /invoices/overdue", "POST /invoices/overdue", "POST /invoices/import"],
    ],
    [{ route: "GET /invoices?status=overdue" }, ["GET /invoices?status=overdue"]],
    [
      { service: "fx-rates" },
      ["POST /invoices/overdue", "settlements.run", "POST /invoices/overdue"],
    ],
    [{ minMs: 1500 }, ["test overdue-totals", "POST /invoices/import"]],
  ])("filters by %j", (filter, expected) => {
    expect(roots(filter)).toEqual(expected);
  });
});

describe("the fixture traces.get", () => {
  test("a unique prefix finds the trace; an unknown one is E-TRACE-NOT-FOUND", () => {
    const found = findTrace("traces", BIG_TRACE.id.slice(0, 8));
    const missing = findTrace("traces", "00000000");

    expect(found.ok ? found.value.summary.id : null).toBe(BIG_TRACE.id);
    expect(missing.ok ? null : missing.error.code).toBe("E-TRACE-NOT-FOUND");
  });
});

describe("the fixture traces.compare", () => {
  const turn = (n: 10 | 11 | 12) =>
    TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make(`t-overdue-${n}`) });

  test("each service and root on either side, before against after, missing sides empty", () => {
    const result = fixtureComparison("traces", turn(11), turn(12));

    if (!result.ok) throw new Error(result.error.message);
    expect(
      result.value.routes.map((r) => [r.service, r.route, r.before.p50Ms, r.after.p50Ms])
    ).toEqual([
      ["ledger-api", "GET /customers/:id", null, 38],
      ["ledger-api", "GET /invoices?status=overdue", null, 212],
      ["ledger-api", "POST /invoices/overdue", 122, 840],
      ["ledger-tests", "test overdue-totals", 1400, 3100],
      ["settle-job", "settlements.run", 1240, null],
    ]);
    expect(result.value.routes[0]?.before).toEqual({ p50Ms: null, p95Ms: null, count: 0 });
  });

  test("an unknown Turn fails as the Daemon would, rather than comparing nothing", () => {
    const result = fixtureComparison(
      "traces",
      TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("t-x") }),
      turn(12)
    );

    expect(result.ok ? null : result.error.code).toBe("E-TRACE-NOT-FOUND");
  });

  test.each([
    [[], 50, null],
    [[40], 50, 40],
    [[30, 10, 20, 40], 50, 20],
    [[30, 10, 20, 40], 95, 40],
    [[5, 1, 4, 2, 3], 50, 3],
  ])("nearest rank of %j at p%d is %p", (values, p, expected) => {
    expect(nearestRank(values, p)).toBe(expected);
  });
});
