import {
  type SessionId,
  TraceCompareRpcs,
  TracesRpcs,
  TracesSettingsRpcs,
} from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { compareForSession } from "./compare.ts";
import { TraceSessions } from "./sessions.ts";
import { TraceRuntime } from "./runtime.ts";
import { TraceSettings } from "./settings.ts";
import { TraceStore } from "./store.ts";
import { DeveloperModeState } from "../developerMode/service.ts";
import { firstScope, readScopes, watchScopes } from "./self/reads.ts";

export const TracesRpcsLive = TracesRpcs.toLayer(
  Effect.gen(function* () {
    const runtime = yield* TraceRuntime;
    const store = yield* TraceStore;
    const sessions = yield* TraceSessions;
    const developerMode = yield* DeveloperModeState;

    const scopesFor = (sessionId: SessionId, scope: "self" | undefined) =>
      readScopes({
        runtime,
        sessions,
        polarisWorkspace: Effect.map(developerMode.current, (mode) => mode.polarisWorkspaceId),
        sessionId,
        scope,
      });

    return {
      "traces.watch": ({ sessionId, filter, scope }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const scopes = yield* scopesFor(sessionId, scope);
            let first = true;

            return watchScopes(store, scopes, filter).pipe(
              Stream.mapEffect((page) =>
                Effect.gen(function* () {
                  const setup = yield* runtime.setup(sessionId, first && scope !== "self");
                  first = false;

                  return { ...setup, ...page };
                })
              )
            );
          })
        ),
      "traces.get": ({ sessionId, traceId, scope }) =>
        Effect.gen(function* () {
          const scopes = yield* scopesFor(sessionId, scope);
          const [detail, checkout] = yield* firstScope(scopes, (at) => store.get(at, traceId));
          const history = yield* store.history(checkout, detail.summary.id);

          const usual = Object.fromEntries(
            Object.entries(history.spans).map(([id, usualMs]) => [
              id,
              { usualMs, samples: history.samples[id]! },
            ])
          );

          return { ...detail, usual };
        }),
      "traces.span": ({ sessionId, traceId, spanId, scope }) =>
        Effect.flatMap(scopesFor(sessionId, scope), (scopes) =>
          Effect.map(
            firstScope(scopes, (at) => store.span(at, traceId, spanId)),
            ([detail]) => detail
          )
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
