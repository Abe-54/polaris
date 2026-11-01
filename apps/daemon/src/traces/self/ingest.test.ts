/** `traces.ingestSelf` and Self-Trace retention through the real store and worker. */
import { expect, test } from "bun:test";
import {
  type DeveloperMode,
  SELF_TRACE_BATCH_SPANS,
  type SelfSpan,
  SelfTraceRejected,
  SelfTraceRpcs,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { type RpcClient, RpcTest } from "effect/rpc";
import { developerMode as modeOf, makeTestDeveloperMode } from "./testing.ts";
import { TraceStore } from "../store.ts";
import { spanFixture, traceFixture, type TraceFixture, withTraceFixture } from "../testing.ts";
import { ingestSelfSpans } from "./ingest.ts";
import { SelfTraceRpcsLive } from "./rpcs.ts";
import { SELF_CHECKOUT } from "./scope.ts";

const POLARIS = WorkspaceId.make("polaris-workspace");

const on = modeOf({ stored: true, polarisWorkspaceId: POLARIS });

/** A unique non-zero id: a prefix digit, then the index zero-padded. */
const hexId = (prefix: string, index: number, length: number) =>
  prefix + index.toString(16).padStart(length - 1, "0");

const nanos = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

const selfSpan = (
  index: number,
  startMs = Date.now(),
  extra: Partial<SelfSpan> = {}
): SelfSpan => ({
  traceId: hexId("a", index, 32),
  id: hexId("b", index, 16),
  parentId: null,
  name: `renderer.frame ${index}`,
  kind: "internal",
  status: "ok",
  statusMessage: "",
  traceState: "",
  startTimeUnixNano: nanos(startMs),
  endTimeUnixNano: nanos(startMs + 5),
  attributes: { "http.request.header.authorization": "Bearer private", frame: index },
  resource: { "service.name": "spoofed" },
  scope: { name: "renderer", version: "1", attributes: {} },
  events: [],
  links: [],
  droppedAttributes: 0,
  droppedEvents: 0,
  droppedLinks: 0,
  ...extra,
});

const withIngest = <A>(
  store: TraceStore["Service"],
  mode: DeveloperMode,
  run: (client: RpcClient.FromGroup<typeof SelfTraceRpcs>) => Effect.Effect<A, unknown>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const developerMode = yield* makeTestDeveloperMode(mode);

        const client = yield* RpcTest.makeClient(SelfTraceRpcs).pipe(
          Effect.provide(
            SelfTraceRpcsLive.pipe(
              Layer.provide(Layer.merge(developerMode.layer, Layer.succeed(TraceStore, store)))
            )
          )
        );

        return yield* run(client);
      })
    )
  );

test("ingestSelf refuses batches while Developer Mode is off and stores nothing", () =>
  withTraceFixture(async (f) => {
    const error = await withIngest(f.store, modeOf(), (client) =>
      Effect.flip(
        client["traces.ingestSelf"]({ service: "polaris-desktop-main", spans: [selfSpan(0)] })
      )
    );

    expect(error).toBeInstanceOf(SelfTraceRejected);
    expect(error).toHaveProperty("reason", "developer-mode-off");
    expect(await Effect.runPromise(f.store.workerRunning)).toBe(false);
  }));

test("ingestSelf stores Client Spans in the Self-Trace scope under the batch's service, redacted", () =>
  withTraceFixture(async (f) => {
    const inverted = selfSpan(1, Date.now(), { endTimeUnixNano: nanos(Date.now() - 10_000) });

    const result = await withIngest(f.store, on, (client) =>
      client["traces.ingestSelf"]({
        service: "polaris-desktop-main",
        spans: [selfSpan(0), inverted],
      })
    );

    expect(result).toEqual({ accepted: 1 });
    await Effect.runPromise(f.store.flush);
    const page = await Effect.runPromise(f.store.list(SELF_CHECKOUT));
    expect(page.traces.map((trace) => [trace.root, trace.service])).toEqual([
      ["renderer.frame 0", "polaris-desktop-main"],
    ]);

    const detail = await Effect.runPromise(f.store.get(SELF_CHECKOUT, page.traces[0]!.id));
    expect(detail.spans[0]?.attributes["http.request.header.authorization"]).toBe("[redacted]");
    expect(detail.spans[0]?.polaris.workspaceId).toBe(POLARIS);
    expect((await Effect.runPromise(f.store.list(f.root))).total).toBe(0);
  }));

test("ingestSelf refuses a batch over the span bound before anything is stored", () =>
  withTraceFixture(async (f) => {
    const spans = Array.from({ length: SELF_TRACE_BATCH_SPANS + 1 }, (_, i) => selfSpan(i));

    const exit = await withIngest(f.store, on, (client) =>
      Effect.exit(client["traces.ingestSelf"]({ service: "polaris-mobile", spans }))
    );

    expect(exit._tag).toBe("Failure");
    expect(await Effect.runPromise(f.store.workerRunning)).toBe(false);
  }));

const checkoutSpans = (f: TraceFixture, startMs: number, count: number) =>
  Effect.runPromise(
    f.store.ingest({
      bytes: new TextEncoder().encode(
        JSON.stringify(
          traceFixture(
            Array.from({ length: count }, (_, i) =>
              spanFixture({
                traceId: hexId("c", i, 32),
                id: hexId("d", i, 16),
                start: nanos(startMs + i),
              })
            )
          )
        )
      ),
      signal: "traces",
      contentType: "application/json",
      context: f.context,
    })
  );

test("Self-Traces age out after 24 hours while a checkout keeps Traces of the same age", () =>
  withTraceFixture(async (f) => {
    const dayAgo = Date.now() - 25 * 3600_000;

    await Effect.runPromise(
      ingestSelfSpans(f.store, {
        service: "polaris-daemon",
        spans: [selfSpan(0, dayAgo), selfSpan(1)],
        workspaceId: null,
      })
    );
    await checkoutSpans(f, dayAgo, 1);
    await Effect.runPromise(f.store.flush);

    const self = await Effect.runPromise(f.store.list(SELF_CHECKOUT));
    expect(self.traces.map((trace) => trace.root)).toEqual(["renderer.frame 1"]);
    expect((await Effect.runPromise(f.store.list(f.root))).total).toBe(1);
  }));

test("Self-Traces have their own byte budget, separate from the checkout's", () =>
  withTraceFixture(
    async (f) => {
      const start = Date.now() - 60_000;

      for (let batch = 0; batch < 4; batch++)
        await Effect.runPromise(
          ingestSelfSpans(f.store, {
            service: "polaris-daemon",
            spans: Array.from({ length: 50 }, (_, i) =>
              selfSpan(batch * 50 + i, start + batch * 50 + i)
            ),
            workspaceId: null,
          })
        );
      await checkoutSpans(f, start, 200);
      await Effect.runPromise(f.store.flush);

      const self = await Effect.runPromise(f.store.list(SELF_CHECKOUT, { limit: 200 }));
      expect(self.total).toBeGreaterThan(0);
      expect(self.total).toBeLessThan(200);
      // Pruning removes the oldest first.
      expect(self.traces.at(-1)!.startTimeUnixNano > nanos(start + 50)).toBe(true);
      expect((await Effect.runPromise(f.store.list(f.root, { limit: 200 }))).total).toBe(200);
    },
    { selfMaxBytes: 64 * 1024 }
  ));
