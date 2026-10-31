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
            let first = true;

            return store.watch(checkout, filter).pipe(
              Stream.mapEffect((page) =>
                Effect.gen(function* () {
                  const setup = yield* runtime.setup(sessionId, first);
                  first = false;

                  return { ...setup, ...page };
                })
              )
            );
          })
        ),
      "traces.get": ({ sessionId, traceId }) =>
        Effect.flatMap(runtime.checkout(sessionId), (checkout) => store.get(checkout, traceId)),
      "traces.span": ({ sessionId, traceId, spanId }) =>
        Effect.flatMap(runtime.checkout(sessionId), (checkout) =>
          store.span(checkout, traceId, spanId)
        ),
    };
  })
);
