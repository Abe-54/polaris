/** The Daemon's Spans reach the real trace store only while Developer Mode is effectively on. */
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { harnessEnv } from "../../harness/environment.ts";
import { developerMode as modeOf, makeTestDeveloperMode } from "./testing.ts";
import { TraceStore } from "../store.ts";
import { withTraceFixture } from "../testing.ts";
import { selfTraceExportFor } from "./export.ts";
import { SELF_CHECKOUT } from "./scope.ts";
import { SelfTracer } from "./tracer.ts";

const leased = modeOf({ leases: 1 });

test("Daemon Spans are stored as polaris-daemon Self-Traces only while Developer Mode is on, switching live", () =>
  withTraceFixture(async (f) => {
    const tracer = new SelfTracer();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const developerMode = yield* makeTestDeveloperMode();
          yield* Layer.build(
            selfTraceExportFor(tracer).pipe(
              Layer.provide(Layer.merge(developerMode.layer, Layer.succeed(TraceStore, f.store)))
            )
          );

          const traced = (name: string) =>
            Effect.withSpan(Effect.withSpan(Effect.void, `${name}.child`), name).pipe(
              Effect.withTracer(tracer)
            );

          const roots = Effect.gen(function* () {
            yield* Effect.sync(() => tracer.flush());
            yield* f.store.flush;
            const page = yield* f.store.list(SELF_CHECKOUT);

            return page.traces.map((trace) => [trace.root, trace.service, trace.spans]);
          });

          const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));

          yield* traced("while.off");
          expect(tracer.exporting).toBe(false);
          // Off, nothing wakes the lazy store worker.
          expect(yield* f.store.workerRunning).toBe(false);

          yield* developerMode.set(leased);
          yield* settle;
          yield* traced("while.leased");
          yield* developerMode.set(modeOf());
          yield* settle;
          yield* traced("after.release");
          yield* developerMode.set(modeOf({ stored: true }));
          yield* settle;
          yield* traced("while.stored");
          yield* Effect.sleep(50);

          expect(yield* roots).toEqual([
            ["while.stored", "polaris-daemon", 2],
            ["while.leased", "polaris-daemon", 2],
          ]);
          // Self-Traces never join a checkout's own Traces.
          expect((yield* f.store.list(f.root)).total).toBe(0);
        })
      )
    );
  }));

test("a Daemon exporting Self-Traces still launches Harnesses without trace context", () =>
  withTraceFixture(async (f) => {
    const tracer = new SelfTracer();
    const source = { PATH: "/usr/bin", POLARIS_OTEL_ENDPOINT: "http://127.0.0.1:4319" };
    const off = harnessEnv(source);

    const on = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const developerMode = yield* makeTestDeveloperMode(leased);
          yield* Layer.build(
            selfTraceExportFor(tracer).pipe(
              Layer.provide(Layer.merge(developerMode.layer, Layer.succeed(TraceStore, f.store)))
            )
          );
          yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }));
          expect(tracer.exporting).toBe(true);

          return yield* Effect.sync(() => harnessEnv(source)).pipe(
            Effect.withSpan("harness.launch"),
            Effect.withTracer(tracer)
          );
        })
      )
    );

    expect(on).toEqual(off);
    expect(
      Object.keys(on).filter((key) => /^(POLARIS_OTEL_|TRACEPARENT|TRACESTATE)/i.test(key))
    ).toEqual([]);
  }));
