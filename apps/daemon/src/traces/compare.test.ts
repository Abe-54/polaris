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
import { TEST_SESSION } from "./testing.ts";
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
