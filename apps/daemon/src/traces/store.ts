import { existsSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import {
  TraceComparison,
  type TraceCompareSelector,
  TraceDetail,
  TraceError,
  TraceFilter,
  TraceSummary,
  SpanDetail,
} from "@polaris/protocol";
import { releaseMemory } from "../memory/release.ts";
import { polarisHome } from "../paths.ts";
import { TraceWorkerClient, WorkerFailure, type TraceWorkerOptions } from "./workerClient.ts";
import {
  TraceHistory,
  TraceWorkerRequest,
  TraceView,
  TraceToolPage,
  TraceToolSpan,
} from "./workerProtocol.ts";
import { IngestError, type IngestContext } from "./ingest.ts";

const TracePage = Schema.Struct({ traces: Schema.Array(TraceSummary), total: Schema.Number });

export type TracePage = typeof TracePage.Type;

export class TraceStore extends Context.Service<
  TraceStore,
  {
    readonly ingest: (request: {
      readonly bytes: Uint8Array;
      readonly signal: "traces" | "logs";
      readonly contentType: "application/json" | "application/x-protobuf";
      readonly context: IngestContext;
    }) => Effect.Effect<number, IngestError>;
    readonly compare: (
      checkout: string,
      a: TraceCompareSelector,
      b: TraceCompareSelector,
      baselineStart?: string
    ) => Effect.Effect<TraceComparison, TraceError>;
    readonly list: (checkout: string, filter?: TraceFilter) => Effect.Effect<TracePage, TraceError>;
    readonly view: (
      checkout: string,
      traceId: string,
      focus: "slow" | "errors" | "all"
    ) => Effect.Effect<TraceView, TraceError>;
    readonly toolList: (
      checkout: string,
      filter: TraceFilter
    ) => Effect.Effect<TraceToolPage, TraceError>;
    readonly toolSpan: (
      checkout: string,
      traceId: string,
      spanId: string
    ) => Effect.Effect<TraceToolSpan, TraceError>;
    readonly overlapping: (
      checkout: string,
      start: string,
      end: string
    ) => Effect.Effect<TracePage, TraceError>;
    readonly get: (checkout: string, traceId: string) => Effect.Effect<TraceDetail, TraceError>;
    readonly span: (
      checkout: string,
      traceId: string,
      spanId: string
    ) => Effect.Effect<SpanDetail, TraceError>;
    readonly history: (
      checkout: string,
      traceId: string,
      includeSpans?: boolean
    ) => Effect.Effect<TraceHistory, TraceError>;
    readonly link: (checkout: string, traceId: string) => Effect.Effect<void, TraceError>;
    readonly watch: (
      checkout: string,
      filter?: TraceFilter
    ) => Stream.Stream<TracePage, TraceError>;
    readonly flush: Effect.Effect<void, TraceError>;
    /** Receiver/configuration changes wake existing watches without a polling loop. */
    readonly notify: Effect.Effect<void>;
    readonly workerRunning: Effect.Effect<boolean>;
  }
>()("polaris/traces/TraceStore") {
  static layerAt = (filename: string, options: TraceWorkerOptions = {}) =>
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
          compare: (checkout, a, b, baselineStart) =>
            read(
              TraceWorkerRequest.cases.Compare.make({
                checkout,
                a,
                b,
                ...(baselineStart === undefined ? undefined : { baselineStart }),
              }),
              TraceComparison
            ),
          list,
          view: (checkout, traceId, focus) =>
            read(TraceWorkerRequest.cases.View.make({ checkout, traceId, focus }), TraceView),
          toolList: (checkout, filter) =>
            read(TraceWorkerRequest.cases.ToolList.make({ checkout, filter }), TraceToolPage),
          toolSpan: (checkout, traceId, spanId) =>
            read(
              TraceWorkerRequest.cases.ToolSpan.make({ checkout, traceId, spanId }),
              TraceToolSpan
            ),
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

  static readonly layer = Layer.suspend(() =>
    TraceStore.layerAt(join(polarisHome(), "traces.sqlite"))
  );
}
