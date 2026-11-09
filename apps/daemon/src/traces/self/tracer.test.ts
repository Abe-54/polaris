/** An idle Host with Developer Mode on leaves the trace store's worker asleep (ENG-721). */
import { expect, test } from "bun:test";
import type { SelfSpan } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { TraceStore } from "../store.ts";
import { withTraceFixture } from "../testing.ts";
import { selfTraceExportFor } from "./export.ts";
import { SELF_CHECKOUT } from "./scope.ts";
import { developerMode as modeOf, makeTestDeveloperMode } from "./testing.ts";
import { BATCH_SPANS, SelfTracer } from "./tracer.ts";

const spanIn = (tracer: SelfTracer, name: string, child = `${name}.child`) =>
  Effect.withSpan(Effect.withSpan(Effect.void, child), name).pipe(Effect.withTracer(tracer));

test("hello, auth and lease renewals, with their children, never wake the trace store", () =>
  withTraceFixture(async (f) => {
    const tracer = new SelfTracer();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const developerMode = yield* makeTestDeveloperMode(modeOf({ leases: 1 }));
          yield* Layer.build(
            selfTraceExportFor(tracer).pipe(
              Layer.provide(Layer.merge(developerMode.layer, Layer.succeed(TraceStore, f.store)))
            )
          );
          yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
          expect(tracer.exporting).toBe(true);

          yield* spanIn(tracer, "polaris.rpc.hello", "authenticateConnection");
          yield* spanIn(tracer, "authenticateConnection");
          yield* spanIn(tracer, "polaris.rpc.presence.report");
          yield* spanIn(tracer, "polaris.rpc.developerMode.lease");
          yield* Effect.sync(() => tracer.flush());
          yield* Effect.sleep(50);
          expect(yield* f.store.workerRunning).toBe(false);

          yield* spanIn(tracer, "polaris.rpc.sessions.send");
          yield* Effect.sync(() => tracer.flush());
          yield* Effect.sleep(50);
          yield* f.store.flush;
          const page = yield* f.store.list(SELF_CHECKOUT);
          expect(page.traces.map((trace) => [trace.root, trace.spans])).toEqual([
            ["polaris.rpc.sessions.send", 2],
          ]);
        })
      )
    );
  }));

test("Self-Spans wait in memory until a batch fills", () => {
  const tracer = new SelfTracer({ warn: () => {}, error: () => {} });
  const batches: Array<ReadonlyArray<SelfSpan>> = [];
  tracer.setSink((spans) => void batches.push(spans));

  const traced = (name: string) =>
    Effect.runSync(Effect.void.pipe(Effect.withSpan(name), Effect.withTracer(tracer)));

  traced("first");
  expect(batches).toEqual([]);

  for (let i = 1; i < BATCH_SPANS; i++) traced(`span.${i}`);

  expect(batches.map((batch) => batch.length)).toEqual([BATCH_SPANS]);
  tracer.setSink(null);
});
