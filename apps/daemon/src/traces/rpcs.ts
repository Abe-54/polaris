import { TraceCompareRpcs, TracesRpcs, TracesSettingsRpcs } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { compareForSession } from "./compare.ts";
import { TraceSessions } from "./sessions.ts";
import { TraceRuntime } from "./runtime.ts";
import { TraceSettings } from "./settings.ts";
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

export const TracesSettingsRpcsLive = TracesSettingsRpcs.toLayer(
  Effect.gen(function* () {
    const settings = yield* TraceSettings;

    return {
      "traces.settings": ({ workspaceId }) => settings.get(workspaceId),
      "traces.setSettings": ({ workspaceId, settings: patch }) =>
        settings.patch(workspaceId, patch),
    };
  })
);

export const TraceCompareRpcsLive = TraceCompareRpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* TraceStore;
    const sessions = yield* TraceSessions;

    return {
      "traces.compare": ({ sessionId, a, b }) =>
        compareForSession(store, sessions, sessionId, a, b),
    };
  })
);
