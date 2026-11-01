import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import {
  TraceCompareRpcs,
  TraceCompareSelector,
  TraceTurn,
  SessionId,
  TurnId,
} from "@polaris/protocol";
import { TraceSessions } from "./sessions.ts";
import { TraceStore } from "./store.ts";
import { TraceCompareRpcsLive } from "./rpcs.ts";
import { compareForSession } from "./compare.ts";
import { TEST_SESSION, spanFixture, traceFixture } from "./testing.ts";
import { baseline, compareContext, turnSelector, withComparisons } from "./compare.testing.ts";

const sessions = { session: () => Effect.succeed(compareContext) };

const read = (
  store: TraceStore["Service"],
  a: TraceCompareSelector = baseline,
  b: TraceCompareSelector = turnSelector(2)
) => Effect.runPromise(compareForSession(store, sessions, TEST_SESSION, a, b));

test("Baseline compares every retained earlier Turn in this checkout with the target Turn, with nearest-rank percentiles", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(0, [90, 100]);
    await ingest(1, [120, 130, 140]);
    const otherSession = SessionId.make("other-session");

    await ingest(1, [105, 115, 125], {
      context: {
        ...compareContext,
        sessionId: otherSession,
        turns: compareContext.turns.map((interval) => ({
          ...interval,
          turn: TraceTurn.make({
            ...interval.turn,
            sessionId: otherSession,
            id: TurnId.make(`other-${interval.turn.id}`),
          }),
        })),
      },
    });
    await ingest(2, [800, 820, 840, 880, 900]);
    await ingest(3, [9999, 9999, 9999]);
    await ingest(1, [9999, 9999, 9999], { checkout: "/another-checkout" });
    await ingest(1, [9999, 9999, 9999], { context: { ...compareContext, turns: [] } });
    await ingest(1, [9999, 9999, 9999], { route: "GET /unrelated" });

    expect((await read(store)).routes).toEqual([
      {
        service: "ledger-api",
        route: "POST /invoices",
        before: { count: 8, p50Ms: 115, p95Ms: 140 },
        after: { count: 5, p50Ms: 840, p95Ms: 900 },
      },
    ]);
  }));

test("explicit Turns stay explicit, and equal selectors compare with themselves", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(0, [999, 999, 999]);
    await ingest(1, [100, 120, 130]);
    await ingest(2, [800, 840, 900]);
    expect((await read(store, turnSelector(1))).routes[0]!.before).toEqual({
      count: 3,
      p50Ms: 120,
      p95Ms: 130,
    });
    const same = await read(store, turnSelector(2));
    expect(same.routes[0]!.before).toEqual(same.routes[0]!.after);
  }));

const turns = (first: number, last: number) =>
  TraceCompareSelector.cases.Turns.make({
    firstTurnId: turnSelector(first).turnId,
    lastTurnId: turnSelector(last).turnId,
  });

test("a Turn range counts the traces of every Turn in it, as b against Baseline and as either explicit side", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(0, [100, 110, 120]);
    await ingest(1, [800, 800]);
    await ingest(2, [840]);
    await ingest(3, [9999, 9999, 9999]);

    const counts = async (a: TraceCompareSelector, b: TraceCompareSelector) =>
      (await read(store, a, b)).routes.map((r) => [r.before.count, r.after.p50Ms, r.after.count]);

    expect(await counts(baseline, turns(1, 2))).toEqual([[3, 800, 3]]);
    expect(await counts(turnSelector(0), turns(1, 2))).toEqual([[3, 800, 3]]);
    expect(await counts(turns(0, 1), turnSelector(2))).toEqual([[5, null, 1]]);
    expect(await counts(baseline, turns(2, 2))).toEqual([[5, null, 1]]);
  }));

test.each([
  ["a range that ends before it starts", turnSelector(0), turns(2, 1), "E-INPUT"],
  [
    "a range with a Turn outside the session",
    turnSelector(0),
    TraceCompareSelector.cases.Turns.make({
      firstTurnId: turnSelector(1).turnId,
      lastTurnId: TurnId.make("elsewhere"),
    }),
    "E-TRACE-NOT-FOUND",
  ],
  [
    "a range against a trace",
    TraceCompareSelector.cases.Trace.make({ traceId: "ffffffff" }),
    turns(1, 2),
    "E-INPUT",
  ],
  ["a range as a, Baseline as b", turns(1, 2), baseline, "E-INPUT"],
] as const)("%s is refused with %p's code", (_name, a, b, code) =>
  withComparisons(async ({ store }) => {
    const failure = await Effect.runPromise(
      Effect.flip(compareForSession(store, sessions, TEST_SESSION, a, b))
    );

    expect(failure.code).toBe(code);
  })
);

test.each([
  [2, 3],
  [3, 2],
  [0, 3],
  [3, 0],
])("%i before and %i after samples report no baseline with counts preserved", (before, after) =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(
      1,
      Array.from({ length: before }, () => 120)
    );
    await ingest(
      2,
      Array.from({ length: after }, () => 840)
    );
    const result = await read(store, turnSelector(1));
    expect(result.routes[0]!.before).toEqual({ count: before, p50Ms: null, p95Ms: null });
    expect(result.routes[0]!.after).toEqual({ count: after, p50Ms: null, p95Ms: null });
  })
);

test("service/root pairs stay separate and missing route sides have zero counts", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(1, [100, 120, 130]);
    await ingest(2, [800, 840, 900]);
    await ingest(2, [20, 30, 40], { service: "other-service" });
    await ingest(1, [1, 2, 3], { route: "GET /removed" });
    const routes = (await read(store, turnSelector(1))).routes;
    expect(routes.map((r) => [r.service, r.route, r.before.count, r.after.count])).toEqual([
      ["ledger-api", "GET /removed", 3, 0],
      ["ledger-api", "POST /invoices", 3, 3],
      ["other-service", "POST /invoices", 0, 3],
    ]);
    expect(routes[0]!.before.p50Ms).toBeNull();
  }));

test("slowest new span compares semantic names and parents, rather than ids or just duration", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(1, [1000, 1000, 1000], { child: { name: "existing", ms: 900 } });
    await ingest(2, [1000], { child: { name: "existing", ms: 950 } });
    const ids = await ingest(2, [1000, 1000], { child: { name: "new-query", ms: 800 } });
    expect((await read(store)).routes[0]!.slowestNew).toEqual({
      name: "new-query",
      service: "ledger-api",
      durationMs: 800,
      traceId: ids[0]!,
      spanId: "3333333333333333",
    });
    await ingest(2, [1000], { child: { name: "existing", ms: 960, parent: "different-handler" } });
    expect((await read(store)).routes[0]!.slowestNew?.name).toBe("different-handler");
  }));

test("trace ids resolve exactly or by unique prefix, with sparse counts and checkout authority", () =>
  withComparisons(async ({ store, ingest }) => {
    const [first] = await ingest(2, [120]);
    const trace = (id: string) => TraceCompareSelector.cases.Trace.make({ traceId: id });

    const unique = await Effect.runPromise(
      compareForSession(store, sessions, TEST_SESSION, trace(first!.slice(0, 8)), trace(first!))
    );

    expect(unique.routes[0]!.before.count).toBe(1);

    const [second] = await ingest(2, [840]);

    const result = await Effect.runPromise(
      compareForSession(store, sessions, TEST_SESSION, trace(first!), trace(second!))
    );

    expect(result.routes[0]!.before).toEqual({ count: 1, p50Ms: null, p95Ms: null });
    expect(result.routes[0]!.after).toEqual({ count: 1, p50Ms: null, p95Ms: null });
    expect(
      (
        await Effect.runPromise(
          Effect.flip(
            compareForSession(store, sessions, TEST_SESSION, trace("00000000"), trace(second!))
          )
        )
      ).code
    ).toBe("E-TRACE-AMBIGUOUS");
    const [foreign] = await ingest(2, [999], { checkout: "/other" });
    expect(
      (
        await Effect.runPromise(
          Effect.flip(
            compareForSession(store, sessions, TEST_SESSION, trace(foreign!), trace(second!))
          )
        )
      ).code
    ).toBe("E-TRACE-NOT-FOUND");
  }));

test("expired samples don't become a baseline and empty known Turns stay empty", () =>
  withComparisons(async ({ store, ingest }) => {
    const offset = -8n * 86400n * 1_000_000_000n;

    await ingest(1, [100, 120, 130], {
      offset,
      context: {
        ...compareContext,
        turns: compareContext.turns.map((interval) => ({
          ...interval,
          start: (BigInt(interval.start) + offset).toString(),
          end: interval.end === null ? null : (BigInt(interval.end) + offset).toString(),
        })),
      },
    });
    await ingest(2, [800, 840, 900]);
    expect((await read(store)).routes[0]!.before).toEqual({ count: 0, p50Ms: null, p95Ms: null });
    expect((await read(store, turnSelector(0), turnSelector(1))).routes).toEqual([]);
  }));

test("Baseline rejects invalid selector placement, mixed pairs and unknown Turn ids through real RPC", () =>
  withComparisons(async ({ store }) => {
    const sessionLayer = Layer.succeed(
      TraceSessions,
      TraceSessions.of({
        ...sessions,
        workspace: () => Effect.succeed(compareContext),
        active: () => Effect.succeed(true),
        workspaceActive: () => Effect.succeed(true),
      })
    );

    const call = (a: TraceCompareSelector, b: TraceCompareSelector, sessionId = TEST_SESSION) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(TraceCompareRpcs);

            return yield* client["traces.compare"]({ sessionId, a, b });
          })
        ).pipe(
          Effect.provide(TraceCompareRpcsLive),
          Effect.provide(sessionLayer),
          Effect.provide(Layer.succeed(TraceStore, store))
        )
      );

    for (const [a, b] of [
      [baseline, baseline],
      [turnSelector(1), baseline],
      [baseline, TraceCompareSelector.cases.Trace.make({ traceId: "12345678" })],
    ])
      expect(
        await call(a!, b!).then(
          () => "unexpected success",
          (error: { code: string }) => error.code
        )
      ).toBe("E-INPUT");
    expect(
      await call(
        baseline,
        TraceCompareSelector.cases.Turn.make({ turnId: TurnId.make("unknown") })
      ).then(
        () => "unexpected success",
        (error: { code: string }) => error.code
      )
    ).toBe("E-TRACE-NOT-FOUND");
    expect(await call(baseline, turnSelector(2))).toMatchObject({ routes: [] });
  }));

test("retention-pruned partial traces are reported and excluded from sample counts", () =>
  withComparisons(
    async ({ store, ingest }) => {
      await ingest(1, [1000], { child: { name: "POST /invoices", ms: 800, at: 15000 } });
      await ingest(2, [800, 840, 900]);
      const route = (await read(store)).routes[0]!;
      expect(route.partial).toEqual({ before: 0, after: 1 });
      expect(route.after).toEqual({ count: 3, p50Ms: null, p95Ms: null });
    },
    { maxAgeMs: 15000 }
  ));

test("comparison statistics aren't truncated by the listing tool's fifty-Trace cap", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(
      1,
      Array.from({ length: 61 }, (_, i) => i + 1)
    );
    await ingest(2, [800, 840, 900]);
    const before = (await read(store)).routes[0]!.before;

    expect(before).toEqual({ count: 61, p50Ms: 31, p95Ms: 58 });
  }));

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

    const comparison = await read(store);
    const phantom = comparison.routes.filter((r) => r.route === "pg.query invoices");

    expect(phantom).toMatchObject([{ after: { count: 0 }, partial: { before: 0, after: 1 } }]);
    expect(phantom[0]!.slowestNew).toBeUndefined();

    const root = {
      ...orphan,
      spanId: orphan.parentSpanId,
      parentSpanId: "",
      kind: 2,
      name: "POST /invoices",
    };

    const completed = traceFixture([root]);
    completed.resourceSpans[0]!.resource.attributes[0]!.value.stringValue = "ledger-api";
    await Effect.runPromise(
      store.ingest({
        signal: "traces",
        contentType: "application/json",
        bytes: new TextEncoder().encode(JSON.stringify(completed)),
        context: compareContext,
      })
    );
    const recovered = (await read(store)).routes;

    expect(recovered.map((route) => [route.route, route.after.count, route.partial])).toEqual([
      ["POST /invoices", 4, undefined],
    ]);
  }));

test.each([2, 5])(
  "a kind %i span with an upstream parent is a complete local root even with an earlier child",
  (kind) =>
    withComparisons(async ({ store, ingest }) => {
      await ingest(1, [100, 110, 120]);
      await ingest(2, [800, 820, 840]);
      const start = BigInt(compareContext.turns[2]!.start) + 1_000_000_000n;

      const root = {
        ...spanFixture({
          traceId: "abcdef00abcdef00abcdef00abcdef00",
          id: "6666666666666666",
          parentId: "7777777777777777",
          start: start.toString(),
        }),
        kind,
        name: "POST /invoices",
        events: [],
      };

      const child = {
        ...root,
        spanId: "8888888888888888",
        parentSpanId: root.spanId,
        kind: 3,
        name: "early-child",
        startTimeUnixNano: (start - 25_000_000_000n).toString(),
      };

      const batch = traceFixture([child, root]);
      batch.resourceSpans[0]!.resource.attributes[0]!.value.stringValue = "ledger-api";
      await Effect.runPromise(
        store.ingest({
          signal: "traces",
          contentType: "application/json",
          bytes: new TextEncoder().encode(JSON.stringify(batch)),
          context: compareContext,
        })
      );
      const route = (await read(store)).routes[0]!;

      expect(route.before.count).toBe(3);
      expect(route.after.count).toBe(4);
      expect(route.partial).toBeUndefined();
    })
);
