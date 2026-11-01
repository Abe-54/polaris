import { expect, test } from "bun:test";
import { BIG_TRACE, ERROR_TRACE, FIXTURE_DETAILS, FIXTURE_TURNS } from "../preview/fixtures.ts";
import { foldedLine, turnTraces, traceFailure } from "./model.ts";

const ALL = FIXTURE_DETAILS.map((d) => d.summary);

const TURN_12 = new Set<string>([FIXTURE_TURNS[12].id]);

test("a Turn's failing traces lead; the rest run slowest first with the same route's last run", () => {
  const shown = turnTraces(ALL, TURN_12);

  expect(shown.total).toBe(4);
  expect(shown.errors).toBe(1);
  expect(shown.failing.map((t) => t.id)).toEqual([ERROR_TRACE.id]);
  expect(shown.listed.map((r) => [r.trace.root, r.was])).toEqual([
    ["POST /invoices/overdue", 122],
    ["GET /invoices?status=overdue", null],
  ]);
  expect(shown.folded.map((r) => r.trace.root)).toEqual(["GET /customers/:id"]);
  expect(foldedLine(shown.folded)).toBe("1 more under 100 ms");
});

test("an earlier run in the same Turn isn't what it's compared with", () => {
  const rerun = ALL.map((t) =>
    t.id === "5d0a1c6f8e2b4a97b6c8e0f2a4d63e5f" ? { ...t, turn: FIXTURE_TURNS[12] } : t
  );

  const shown = turnTraces(rerun, TURN_12);

  expect(shown.listed.find((r) => r.trace.id === BIG_TRACE.id)?.was).toBeNull();
});

test("past five, even slow traces fold, and the fold doesn't claim they're fast", () => {
  const slow = Array.from({ length: 7 }, (_, i) => ({
    ...ALL[2]!,
    id: `${i}`.padStart(32, "a"),
    durationMs: 300 + i,
  }));

  const shown = turnTraces(slow, TURN_12);

  expect(shown.listed).toHaveLength(5);
  expect(foldedLine(shown.folded)).toBe("2 more");
});

test("a failing trace's card names the exception, the span it happened in and the test's line", () => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === ERROR_TRACE.id);

  if (detail === undefined) throw new Error("the error fixture exists");
  const failure = traceFailure(detail);

  expect(failure.headline.split("\n")[0]).toBe("AssertionError: expect(received).toBe(expected)");
  expect(failure.origin?.name).toBe("GET fx-rates.internal/rates");
  expect(failure.location).toEqual({ path: "test/overdue-totals.test.ts", line: 42, column: 18 });
});

test("with no exception, the card falls back to the deepest error's status and the root's code", () => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === ERROR_TRACE.id);

  if (detail === undefined) throw new Error("the error fixture exists");

  const failure = traceFailure({
    ...detail,
    spans: detail.spans.map((s) => ({ ...s, events: [] })),
  });

  expect(failure.headline).toBe("connect ETIMEDOUT 10.0.4.12:80");
  expect(failure.location).toEqual({ path: "test/overdue-totals.test.ts", line: 42, column: null });
});
