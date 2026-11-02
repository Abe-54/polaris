import { TraceStore } from "./storeService.ts";

export { TraceStore } from "./storeService.ts";

import { existsSync } from "node:fs";

import { Effect, Layer, PubSub, Schema, Stream } from "effect";
import {
  TraceComparison,
  TraceDetail,
  TraceError,
  TraceFilter,
  TraceSummary,
  SpanDetail,
} from "@polaris/protocol";
import { releaseMemory } from "../memory/release.ts";

import { TraceWorkerClient, WorkerFailure, type TraceWorkerOptions } from "./workerClient.ts";
import {
  TraceHistory,
  TraceWorkerRequest,
  TraceView,
  TraceToolPage,
  TraceToolSpan,
} from "./workerProtocol.ts";
import { IngestError } from "./ingest.ts";
import { SpanCapture } from "./capture.ts";
import { SpanStats } from "./stats.ts";
import { SpanErrors } from "./errors.ts";
import { SpanCompare } from "./spanCompare.ts";

const TracePage = Schema.Struct({ traces: Schema.Array(TraceSummary), total: Schema.Number });

export type TracePage = typeof TracePage.Type;

export const traceStoreLayerAt = (filename: string, options: TraceWorkerOptions = {}) =>
  Layer.effect(
    TraceStore,
    Effect.gen(function* () {
      const changes = yield* PubSub.sliding<void>(1);
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
      const notify = Effect.asVoid(PubSub.publish(changes, undefined));

      const worker = new TraceWorkerClient(
        filename,
        options,
        () => {
          Effect.runSync(notify);
        },
        () => Effect.runSync(releaseMemory)
      );

      yield* Effect.addFinalizer(() => Effect.promise(() => worker.close().catch(() => {})));

      const request = (message: TraceWorkerRequest) =>
        Effect.tryPromise({
          try: () => worker.request(message),
          catch: (cause) =>
            cause instanceof WorkerFailure
              ? cause.error
              : new TraceError({
                  code: "E-TRACE-UNAVAILABLE",
                  message: "The trace store is unavailable.",
                  fix: "Retry the request.",
                }),
        });

      const read = <S extends Schema.Top & { readonly DecodingServices: never }>(
        message: TraceWorkerRequest,
        schema: S
      ) =>
        request(message).pipe(
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(schema)(value).pipe(
              Effect.mapError(
                () =>
                  new TraceError({
                    code: "E-TRACE-UNAVAILABLE",
                    message: "The trace store returned an invalid record.",
                    fix: "Retry the request.",
                  })
              )
            )
          )
        );

      const list = (checkout: string, filter: TraceFilter = {}) =>
        !worker.running && filename !== ":memory:" && !existsSync(filename)
          ? Effect.succeed({ traces: [], total: 0 })
          : read(TraceWorkerRequest.cases.List.make({ checkout, filter }), TracePage);

      const watch = (checkout: string, filter: TraceFilter = {}) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            const initial = yield* list(checkout, filter);

            return Stream.concat(
              Stream.succeed(initial),
              Stream.fromSubscription(subscription).pipe(
                Stream.mapEffect(() =>
                  Effect.sleep(250).pipe(Effect.andThen(list(checkout, filter)))
                )
              )
            );
          })
        );

      return TraceStore.of({
        ingest: (input) =>
          Effect.tryPromise({
            try: async () =>
              Schema.decodeUnknownSync(Schema.Number)(
                await worker.request(TraceWorkerRequest.cases.Ingest.make(input))
              ),
            catch: (cause) =>
              new IngestError(
                cause instanceof WorkerFailure ? cause.status : 503,
                "Trace ingest refused"
              ),
          }),
        compare: (checkout, a, b, turns) =>
          read(
            TraceWorkerRequest.cases.Compare.make({
              checkout,
              a,
              b,
              ...(turns === undefined ? undefined : { turns }),
            }),
            TraceComparison
          ),
        list,
        view: (checkout, traceId, focus) =>
          read(TraceWorkerRequest.cases.View.make({ checkout, traceId, focus }), TraceView),
        toolList: (checkout, filter, attributes) =>
          read(
            TraceWorkerRequest.cases.ToolList.make({
              checkout,
              filter,
              ...(attributes === undefined ? undefined : { attributes }),
            }),
            TraceToolPage
          ),
        toolSpan: (checkout, traceId, spanId) =>
          read(
            TraceWorkerRequest.cases.ToolSpan.make({ checkout, traceId, spanId }),
            TraceToolSpan
          ),
        stats: (checkout, filter) =>
          read(TraceWorkerRequest.cases.Stats.make({ checkout, filter }), SpanStats),
        capture: (checkout, filter) =>
          read(TraceWorkerRequest.cases.Capture.make({ checkout, filter }), SpanCapture),
        errors: (checkout, filter) =>
          read(TraceWorkerRequest.cases.Errors.make({ checkout, filter }), SpanErrors),
        spanCompare: (checkout, filter) =>
          read(TraceWorkerRequest.cases.SpanCompare.make({ checkout, filter }), SpanCompare),
        overlapping: (checkout, start, end) =>
          read(TraceWorkerRequest.cases.Overlap.make({ checkout, start, end }), TracePage),
        get: (checkout, traceId) =>
          read(TraceWorkerRequest.cases.Get.make({ checkout, traceId }), TraceDetail),
        span: (checkout, traceId, spanId) =>
          read(TraceWorkerRequest.cases.Span.make({ checkout, traceId, spanId }), SpanDetail),
        history: (checkout, traceId, includeSpans = true) =>
          read(
            TraceWorkerRequest.cases.History.make({ checkout, traceId, includeSpans }),
            TraceHistory
          ),
        link: (checkout, traceId) =>
          Effect.asVoid(request(TraceWorkerRequest.cases.Link.make({ checkout, traceId }))),
        watch,
        changes: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
        notify,
        flush: Effect.suspend(() =>
          worker.running
            ? Effect.asVoid(request(TraceWorkerRequest.cases.Flush.make({})))
            : Effect.void
        ),
        workerRunning: Effect.sync(() => worker.running),
      });
    })
  );
