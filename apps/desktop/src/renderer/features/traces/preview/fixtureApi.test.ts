import { describe, expect, test } from "bun:test";
import { TurnId } from "@polaris/protocol";
import { findTrace, fixtureSnapshot } from "./fixtureApi.ts";
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
    [{ turn: TurnId.make("t-overdue-11") }, ["POST /invoices/overdue", "test overdue-totals"]],
    [{ status: "error" as const }, ["test overdue-totals"]],
    [
      { route: "POST /invoices/*" },
      ["POST /invoices/overdue", "POST /invoices/overdue", "POST /invoices/import"],
    ],
    [{ route: "GET /invoices?status=overdue" }, ["GET /invoices?status=overdue"]],
    [{ service: "fx-rates" }, ["POST /invoices/overdue", "POST /invoices/overdue"]],
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
