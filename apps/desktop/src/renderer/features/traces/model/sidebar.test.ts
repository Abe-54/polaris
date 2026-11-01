import { describe, expect, test } from "bun:test";
import { buildTrace } from "../preview/build.ts";
import { fixtureSnapshot } from "../preview/fixtureApi.ts";
import { BIG_TRACE, FIXTURE_CHECKOUT } from "../preview/fixtures.ts";
import { appendReference, traceReference } from "./reference.ts";
import { groupByTurn, parseTraceFilter, turnKicker } from "./sidebar.ts";

describe("parseTraceFilter", () => {
  test("reads route, service, status and a minimum duration", () => {
    expect(parseTraceFilter("route:/invoices* service:fx-rates status:error >1.5s")).toEqual({
      route: "*/invoices*",
      service: "fx-rates",
      status: "error",
      minMs: 1500,
    });
    expect(parseTraceFilter("min:100ms")).toEqual({ minMs: 100 });
  });

  test("other words search the root name; an empty well is no filter", () => {
    expect(parseTraceFilter("GET /cust")).toEqual({ route: "*GET /cust*" });
    expect(parseTraceFilter("status:maybe")).toEqual({ route: "*status:maybe*" });
    expect(parseTraceFilter("   ")).toBeUndefined();
  });

  test("its filters select what the Daemon's rules would", () => {
    const roots = (text: string) =>
      fixtureSnapshot("traces", parseTraceFilter(text)).traces.map((t) => t.root);

    expect(roots("route:/invoices* >200ms")).toEqual([
      "POST /invoices/overdue",
      "GET /invoices?status=overdue",
      "POST /invoices/import",
    ]);
    expect(roots("status:error")).toEqual(["test overdue-totals", "settlements.run"]);
  });
});

describe("groupByTurn", () => {
  const groups = groupByTurn(fixtureSnapshot("traces").traces);

  test("Turns newest first, with traces between Turns where they fell in time", () => {
    expect(groups.map((g) => [turnKicker(g.turn, 12), g.traces.length])).toEqual([
      ["TURN 12 · NOW", 4],
      ["BETWEEN TURNS", 1],
      ["TURN 11", 3],
      ["TURN 10", 2],
    ]);
  });
});

describe("traceReference", () => {
  const detail = buildTrace(BIG_TRACE, FIXTURE_CHECKOUT);
  const update = detail.spans.find((s) => s.name === "UPDATE invoices") ?? null;

  test("names the trace by its full id with what it was, and the selected span", () => {
    expect(traceReference(detail.summary, update)).toBe(
      "Trace `4f1c0e5b7d2a46c1b3e8d90f61a59a2e` in this checkout: `POST /invoices/overdue` (ledger-api), 840 ms, 434 spans, turn 12\n" +
        "Span `a91f5d6e7b8c03c2`: `UPDATE invoices` (ledger-api), 112 ms"
    );
  });

  test("goes after the draft with a blank line", () => {
    expect(appendReference("Why is this slow?  \n", "Trace x")).toBe(
      "Why is this slow?\n\nTrace x"
    );
    expect(appendReference(" ", "Trace x")).toBe("Trace x");
  });
});
