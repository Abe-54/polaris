/**
 * Review's route timings fed what the real Daemon's `traces.compare` and `traces.list` answer.
 * Each test failed on 99ca0343d (RPU, docs/reviews/2026-10-31-traces-RPU.md, P8U).
 */
import { afterEach, expect, test } from "bun:test";
import { TurnId } from "@polaris/protocol";
import { act, cleanup, waitFor } from "@testing-library/react";
import { Effect } from "effect";
import { tracesSelection } from "../../traces/index.ts";
import type { ReviewTurn, TurnPick } from "../data/source.ts";
import {
  changeWord,
  comparePlan,
  type RouteRow,
  routeRows,
  routeTitle,
  selectors,
} from "./model.ts";
import {
  type DaemonStore,
  HOST,
  daemon,
  daemonApi,
  mount,
  reviewTurns,
} from "./daemonFit.testing.tsx";

const { withComparisons, TEST_SESSION } = daemon;

afterEach(cleanup);

const pickTurn = (index: number): TurnPick => ({
  kind: "turn",
  turnId: TurnId.make(`compare-${index}`),
});

/** What useReviewTraces does with a pick: plan, selectors, the Daemon's answer, rows. */
const rowsFor = async (
  store: DaemonStore,
  turns: ReadonlyArray<ReviewTurn>,
  pick: TurnPick
): Promise<ReadonlyArray<RouteRow>> => {
  const plan = comparePlan(turns, turns, pick);

  if (plan === null) throw new Error("no plan");
  const { a, b } = selectors(plan);
  const sessions = { session: () => Effect.succeed(daemon.compareContext) };

  const comparison = await Effect.runPromise(
    daemon.compareForSession(store, sessions, TEST_SESSION, a, b)
  );

  return routeRows(comparison, plan);
};

const THREE_TURNS = reviewTurns([[0], [1], [2]]);

test.each([
  ["a route run once in each Turn", [100], [700]],
  ["a route new in the later Turn (no baseline)", [], [200, 210, 220, 230, 240]],
  ["a route that didn't run in the later Turn", [1900, 1900, 1900, 1900, 1900], []],
])(
  "P8U-1: %s shows real figures or says no baseline, never the '–' placeholder",
  (_name, earlier, later) =>
    withComparisons(async ({ store, ingest }) => {
      await ingest(1, earlier);
      await ingest(2, later);
      const rows = await rowsFor(store, THREE_TURNS, pickTurn(2));

      expect(rows.map((row) => routeTitle(row)).filter((title) => title.includes("–"))).toEqual([]);
    })
);

test("P8U-2: a Review Turn of several Turns counts the traces of all its Turns", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(0, [100, 100, 100]);
    // The user's second message opened Turn 1, where the routes ran; Turn 2 continued it.
    await ingest(1, [800, 800, 800]);
    const rows = await rowsFor(store, reviewTurns([[0], [1, 2]]), pickTurn(1));

    expect(rows.map((r) => [r.route, r.change, r.after.count])).toEqual([
      ["POST /invoices", "compared", 3],
    ]);
  }));

test("P8U-3: a route named with * opens a trace of that route, not of one its glob matches", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(1, [100, 100, 100], { route: "GET /files/*" });
    const own = await ingest(2, [300, 300, 300], { route: "GET /files/*" });

    await ingest(2, [50, 50, 50], { route: "GET /files/report", offset: 3_000_000_000n });
    const { result } = mount(daemonApi(store), { turns: THREE_TURNS, pick: pickTurn(2) });

    await waitFor(() => expect(result.current?.answer.status).toBe("ready"));
    const answer = result.current?.answer;

    const row =
      answer?.status === "ready" ? answer.rows.find((r) => r.route === "GET /files/*") : undefined;

    if (row === undefined) throw new Error("no GET /files/* row");
    act(() => result.current?.onOpenRoute(row));
    const at = { hostKey: HOST, sessionId: TEST_SESSION };

    await waitFor(() => expect(tracesSelection(at).traceId).not.toBeNull());
    expect(own).toContain(tracesSelection(at).traceId ?? "none");
  }));

test("P8U-4: a later p50 of 0 ms reads as a real change word, not 'Infinity× faster'", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(1, [5, 5, 5]);
    await ingest(2, [0, 0, 0]);
    const rows = await rowsFor(store, THREE_TURNS, pickTurn(2));

    expect(rows.map((row) => changeWord(row) ?? "")).not.toContain("Infinity× faster");
  }));
