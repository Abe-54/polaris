/** Which Traces a session's reads see: its checkout, plus Self-Traces in the Polaris Workspace. */
import { expect, test } from "bun:test";
import { type SelfSpan, TracesRpcs, WorkspaceId } from "@polaris/protocol";
import { Effect, Exit, Layer, Option, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { developerMode as modeOf, makeTestDeveloperMode } from "./testing.ts";
import { TracesRpcsLive } from "../rpcs.ts";
import { TraceRuntime } from "../runtime.ts";
import { TraceSessions } from "../sessions.ts";
import { TraceStore } from "../store.ts";
import {
  spanFixture,
  TEST_SESSION,
  TEST_WORKSPACE,
  traceFixture,
  type TraceFixture,
  withTraceFixture,
} from "../testing.ts";
import { ingestSelfSpans } from "./ingest.ts";

const SELF_TRACE = "a".repeat(31) + "1";

const selfSpan = (startMs: number): SelfSpan => ({
  traceId: SELF_TRACE,
  id: "b".repeat(15) + "1",
  parentId: null,
  name: "polaris.rpc.dispatch",
  kind: "server",
  status: "ok",
  statusMessage: "",
  traceState: "",
  startTimeUnixNano: (BigInt(startMs) * 1_000_000n).toString(),
  endTimeUnixNano: (BigInt(startMs + 3) * 1_000_000n).toString(),
  attributes: {},
  resource: {},
  scope: { name: "polaris", version: "", attributes: {} },
  events: [],
  links: [],
  droppedAttributes: 0,
  droppedEvents: 0,
  droppedLinks: 0,
});

const seed = async (f: TraceFixture) => {
  const now = Date.now();
  await Effect.runPromise(
    f.store.ingest({
      bytes: new TextEncoder().encode(
        JSON.stringify(
          traceFixture([spanFixture({ start: (BigInt(now - 1000) * 1_000_000n).toString() })])
        )
      ),
      signal: "traces",
      contentType: "application/json",
      context: f.context,
    })
  );
  await Effect.runPromise(
    ingestSelfSpans(f.store, {
      service: "polaris-daemon",
      spans: [selfSpan(now)],
      workspaceId: null,
    })
  );
  await Effect.runPromise(f.store.flush);
};

const reads = (f: TraceFixture, polarisWorkspaceId: WorkspaceId | null, scope?: "self") =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const developerMode = yield* makeTestDeveloperMode(
          modeOf({ stored: true, polarisWorkspaceId })
        );

        const client = yield* RpcTest.makeClient(TracesRpcs).pipe(
          Effect.provide(
            TracesRpcsLive.pipe(
              Layer.provide(
                Layer.mergeAll(
                  developerMode.layer,
                  Layer.succeed(TraceStore, f.store),
                  Layer.succeed(TraceRuntime, f.runtime),
                  Layer.succeed(TraceSessions, f.sessions)
                )
              )
            )
          )
        );

        const session =
          scope === undefined ? { sessionId: TEST_SESSION } : { sessionId: TEST_SESSION, scope };

        const page = yield* client["traces.watch"](session).pipe(
          Stream.runHead,
          Effect.map(Option.getOrNull)
        );

        const detail = yield* Effect.exit(
          client["traces.get"]({
            ...session,
            traceId: SELF_TRACE.slice(0, 8),
          })
        );

        return {
          services: page?.traces.map((trace) => trace.service) ?? [],
          total: page?.total,
          endpoint: page?.endpoint ?? null,
          selfDetail: Exit.isSuccess(detail) ? detail.value.summary.service : null,
        };
      })
    )
  );

test("a checkout of the Polaris Workspace lists Self-Traces beside its own, newest first", () =>
  withTraceFixture(async (f) => {
    await seed(f);
    expect(await reads(f, TEST_WORKSPACE)).toMatchObject({
      services: ["polaris-daemon", "fixture-service"],
      total: 2,
      selfDetail: "polaris-daemon",
    });
  }));

test("another Workspace's checkout never shows Self-Traces", () =>
  withTraceFixture(async (f) => {
    await seed(f);
    expect(await reads(f, WorkspaceId.make("elsewhere"))).toMatchObject({
      services: ["fixture-service"],
      total: 1,
      selfDetail: null,
    });
    expect(await reads(f, null)).toMatchObject({ services: ["fixture-service"], selfDetail: null });
  }));

test("scope self reads only Self-Traces, with no checkout endpoint", () =>
  withTraceFixture(async (f) => {
    await seed(f);
    expect(await reads(f, null, "self")).toEqual({
      services: ["polaris-daemon"],
      total: 1,
      endpoint: null,
      selfDetail: "polaris-daemon",
    });
  }));
