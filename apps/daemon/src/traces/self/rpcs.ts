/** `traces.ingestSelf`: Clients' Self-Spans, accepted only while Developer Mode is effectively on. */
import { SelfTraceRejected, SelfTraceRpcs } from "@polaris/protocol";
import { Effect } from "effect";
import { DeveloperModeState } from "../../developerMode/service.ts";
import { TraceStore } from "../storeService.ts";
import { ingestSelfSpans, wellFormed } from "./ingest.ts";

export const SelfTraceRpcsLive = SelfTraceRpcs.toLayer(
  Effect.gen(function* () {
    const developerMode = yield* DeveloperModeState;
    const store = yield* TraceStore;

    return {
      "traces.ingestSelf": (batch) =>
        Effect.gen(function* () {
          const mode = yield* developerMode.current;

          if (!mode.effective)
            return yield* new SelfTraceRejected({
              reason: "developer-mode-off",
              message: "Developer Mode is off on this Host.",
            });
          const spans = wellFormed(batch.spans);

          if (spans.length === 0) return { accepted: 0 };

          const accepted = yield* ingestSelfSpans(store, {
            service: batch.service,
            spans,
            workspaceId: mode.polarisWorkspaceId,
          }).pipe(
            Effect.mapError(
              (error) =>
                new SelfTraceRejected({
                  reason: "storage",
                  message:
                    error.status === 429
                      ? "The trace store is busy; retry the batch."
                      : "The trace store refused the batch.",
                })
            )
          );

          return { accepted };
        }),
    };
  })
);
