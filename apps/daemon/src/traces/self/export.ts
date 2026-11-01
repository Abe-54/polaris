/** Follows Developer Mode live: the Daemon's Tracer exports exactly while it is effectively on. */
import { Effect, Layer, Stream } from "effect";
import { DeveloperModeState } from "../../developerMode/service.ts";
import { TraceStore } from "../storeService.ts";
import { ingestSelfSpans } from "./ingest.ts";
import { DAEMON_SERVICE, type SelfTracer, selfTracer } from "./tracer.ts";

export const selfTraceExportFor = (tracer: SelfTracer) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const developerMode = yield* DeveloperModeState;
      const store = yield* TraceStore;

      yield* Effect.addFinalizer(() => Effect.sync(() => tracer.setSink(null)));

      yield* developerMode.changes.pipe(
        Stream.runForEach((mode) =>
          Effect.sync(() =>
            tracer.setSink(
              mode.effective
                ? (spans) =>
                    Effect.runFork(
                      ingestSelfSpans(store, {
                        service: DAEMON_SERVICE,
                        spans,
                        workspaceId: mode.polarisWorkspaceId,
                      }).pipe(Effect.ignore, Effect.withTracerEnabled(false))
                    )
                : null
            )
          )
        ),
        Effect.forkScoped
      );
    })
  );

export const selfTraceExport = selfTraceExportFor(selfTracer);
