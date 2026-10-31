import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import {
  TraceAvailability,
  TraceCompareRpcs,
  TraceCompareSelector,
  TraceComparison,
} from "@polaris/protocol";
import { TraceStore } from "../../traces/store.ts";
import { TraceSessions } from "../../traces/sessions.ts";
import { TraceCompareRpcsLive } from "../../traces/rpcs.ts";
import { TEST_SESSION } from "../../traces/testing.ts";
import {
  baseline,
  compareContext,
  turnSelector,
  withComparisons,
} from "../../traces/compare.testing.ts";
import { sessionTraceTools } from "../sessions/traces.ts";
import { unavailableSessions } from "../sessions/index.ts";
import { attachSessionTools, constellationTools } from "./index.ts";
import { fakeCommands } from "../testing.ts";
import { bindings } from "./data.testing.ts";
import { compareView } from "./compareFormat.ts";
import { traceTools } from "./traces.ts";

const contextSessions = {
  session: () => Effect.succeed(compareContext),
  workspace: () => Effect.succeed(compareContext),
  active: () => Effect.succeed(true),
  workspaceActive: () => Effect.succeed(true),
};

const toolsFor = (store: TraceStore["Service"]) => {
  const traces = sessionTraceTools(
    store,
    {
      setup: () =>
        Effect.succeed({
          availability: TraceAvailability.cases.Listening.make({}),
          endpoint: null,
          userExported: false,
        }),
    },
    contextSessions
  );

  return { ...unavailableSessions, traces };
};

test("MCP omitted a and real traces.compare RPC expose identical route facts from stored Turns", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(1, [100, 120, 130]);
    await ingest(2, [800, 840, 900], { child: { name: "recalculate", ms: 700 } });
    const sessions = toolsFor(store);
    const tool = traceTools(TEST_SESSION, sessions).find((t) => t.name === "compare")!;
    const result = await tool.call({ b: turnSelector(2) });

    const rpcResult = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rpc = yield* RpcTest.makeClient(TraceCompareRpcs);

          return yield* rpc["traces.compare"]({
            sessionId: TEST_SESSION,
            a: baseline,
            b: turnSelector(2),
          });
        })
      ).pipe(
        Effect.provide(TraceCompareRpcsLive),
        Effect.provide(Layer.succeed(TraceStore, store)),
        Effect.provide(Layer.succeed(TraceSessions, TraceSessions.of(contextSessions)))
      )
    );

    expect(result.structuredContent).toEqual(rpcResult);
    expect(result.content[0]!.text).toContain(
      "p50 120 ms → 840 ms  p95 130 ms → 900 ms  runs 3 → 3"
    );
    expect(result.content[0]!.text).toContain("slowest new span: handler");
    expect(result.content).toHaveLength(1);
    expect(rpcResult.routes[0]!.slowestNew).toMatchObject({ durationMs: 900, name: "handler" });
  }));

test("compare is read-only and callable on every Plain/Lead/Worker binding", () =>
  withComparisons(async ({ store, ingest }) => {
    await ingest(2, [840]);

    for (const binding of bindings) {
      const commands = fakeCommands().commands;
      attachSessionTools(commands, toolsFor(store));
      const tool = constellationTools(binding, commands).find((t) => t.name === "compare")!;
      expect(tool.annotations).toEqual({ readOnlyHint: true });
      const result = await tool.call({ b: turnSelector(2) });
      expect(result.content[0]!.text).toContain("no baseline  runs 0 → 1");
      expect(result.structuredContent).toMatchObject({
        routes: [{ before: { count: 0, p50Ms: null }, after: { count: 1, p50Ms: null } }],
      });
    }
  }));

test("compare errors include input fixes, expired selectors and unavailable services", () =>
  withComparisons(async ({ store }) => {
    const tool = traceTools(TEST_SESSION, toolsFor(store)).find((t) => t.name === "compare")!;

    for (const input of [
      {},
      { b: baseline },
      { a: baseline, b: baseline },
      { b: turnSelector(2), checkout: "/forged" },
    ]) {
      const result = await tool.call(input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "E-INPUT" });
      expect(result.content[0]!.text).toContain("Fix:");
    }

    const result = await tool.call({
      a: TraceCompareSelector.cases.Trace.make({ traceId: "ffffffff" }),
      b: TraceCompareSelector.cases.Trace.make({ traceId: "eeeeeeee" }),
    });

    expect(result.structuredContent).toMatchObject({ code: "E-TRACE-NOT-FOUND" });

    const unavailable = traceTools(TEST_SESSION, unavailableSessions).find(
      (t) => t.name === "compare"
    )!;

    expect((await unavailable.call({ b: turnSelector(2) })).structuredContent).toMatchObject({
      code: "E-TRACE-UNAVAILABLE",
    });
  }));

test("compare caps long multi-route text and retains full structured rows and retrieval ids", () => {
  const comparison = TraceComparison.make({
    a: baseline,
    b: turnSelector(2),
    routes: Array.from({ length: 100 }, (_, i) => ({
      service: "ledger-api",
      route: `POST /route-${i}` + "x".repeat(2000),
      before: { count: 3, p50Ms: 120, p95Ms: 130 },
      after: { count: 3, p50Ms: 840, p95Ms: 900 },
    })),
  });

  const view = compareView(comparison);
  expect(view.text.length).toBeLessThanOrEqual(16000);
  expect(view.text).toContain("routes omitted; use compare structuredContent");
  expect(view.text).toContain("chars omitted; full name in structuredContent");
  expect(view.data.routes).toHaveLength(100);
  expect(view.data.routes[0]!.route.length).toBeGreaterThan(2000);
});
