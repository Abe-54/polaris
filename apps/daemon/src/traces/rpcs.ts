import { TracesRpcs } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { TraceRuntime } from "./runtime.ts";
import { TraceStore } from "./store.ts";

export const TracesRpcsLive = TracesRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* TraceRuntime;
    const store = yield* TraceStore;

    return {
      "traces.watch": ({ sessionId, filter }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const checkout = yield* runtime.checkout(sessionId);

            return store
              .watch(checkout, filter)
              .pipe(
                Stream.mapEffect((page) =>
                  Effect.map(runtime.setup(sessionId), (setup) => ({ ...setup, ...page }))
                )
              );
          })
        ),
      "traces.get": ({ sessionId, traceId }) =>
        Effect.gen(function* () {
          const checkout = yield* runtime.checkout(sessionId);
          const detail = yield* store.get(checkout, traceId);
          const history = yield* store.history(checkout, detail.summary.id);

          const usual = Object.fromEntries(
            Object.entries(history.spans).map(([id, usualMs]) => [
              id,
              { usualMs, samples: history.samples[id]! },
            ])
          );

          return { ...detail, usual };
        }),
      "traces.span": ({ sessionId, traceId, spanId }) =>
        Effect.flatMap(runtime.checkout(sessionId), (checkout) =>
          store.span(checkout, traceId, spanId)
        ),
    };
  })
);
