import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  TraceComparison,
  type TraceCompareSelector as Selector,
} from "../../../../packages/protocol/src/index.ts";
import { compareForSession } from "../../../../apps/daemon/src/traces/compare.ts";
import type { TraceStore } from "../../../../apps/daemon/src/traces/store.ts";
import {
  TEST_SESSION,
  spanFixture,
  traceFixture,
} from "../../../../apps/daemon/src/traces/testing.ts";
import {
  baseline,
  compareContext,
  turnSelector,
  withComparisons,
} from "../../../../apps/daemon/src/traces/compare.testing.ts";
import { compareView } from "../../../../apps/daemon/src/mcp/tools/compareFormat.ts";

const sessions = { session: () => Effect.succeed(compareContext) };

const read = (store: TraceStore["Service"], a: Selector = baseline, b: Selector = turnSelector(2)) =>
  Effect.runPromise(compareForSession(store, sessions, TEST_SESSION, a, b));

// compareFormat.ts name(): inline() makes the text well-formed, then slice(0, 240) splits a pair.
test("finding P8-1: compare text never ends a clipped route name on a lone surrogate", () => {
  const route = `${"a".repeat(239)}\u{1F600}${"b".repeat(20)}`;

  const comparison = TraceComparison.make({
    a: baseline,
    b: turnSelector(2),
    routes: [
      {
        service: "ledger-api",
        route,
        before: { count: 0, p50Ms: null, p95Ms: null },
        after: { count: 1, p50Ms: null, p95Ms: null },
      },
    ],
  });

  expect(compareView(comparison).text.isWellFormed()).toBe(true);
});

// Baseline selects `start<target start` on the trace's earliest span, but the Turn comes from the root.
test("finding P8-2: Baseline leaves out a later Turn's trace even when one of its spans starts before the target Turn", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(1, [100, 110, 120]);
    await ingest(2, [800, 820, 840]);
    // A Turn 3 trace (root starts in Turn 3) with a span stamped 25 s earlier, e.g. a skewed clock.
    await ingest(3, [5000], { child: { name: "skewed", ms: 5, at: -25_000 } });

    const route = (await read(store)).routes.find((r) => r.route === "POST /invoices")!;

    expect(route.before).toEqual({ count: 3, p50Ms: 110, p95Ms: 120 });
  }));

// A trace whose root never arrived (in flight, or its process was killed) isn't partial in the store.
test("finding P8-3: a trace without its root span is not counted as a complete sample of a child-named route", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(1, [100, 110, 120]);
    await ingest(2, [800, 820, 840]);

    const start = BigInt(compareContext.turns[2]!.start) + 2_000_000_000n;
    const orphan = {
      ...spanFixture({
        traceId: "abcdef00abcdef00abcdef00abcdef00",
        id: "4444444444444444",
        parentId: "5555555555555555",
        start: start.toString(),
      }),
      name: "pg.query invoices",
      // A client Span whose parent never arrived; a server Span with a remote parent would be a real root.
      kind: 3,
      endTimeUnixNano: (start + 30_000_000n).toString(),
      events: [],
    };
    const batch = traceFixture([orphan]);
    batch.resourceSpans[0]!.resource.attributes[0]!.value.stringValue = "ledger-api";

    await Effect.runPromise(
      store.ingest({
        signal: "traces",
        contentType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify(batch)),
        context: compareContext,
      })
    );

    const phantom = (await read(store)).routes.filter(
      (r) => r.route === "pg.query invoices" && r.after.count > 0
    );

    expect(phantom).toEqual([]);
  }));
