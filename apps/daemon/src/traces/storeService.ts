import { Context, Effect, Layer, type Scope, type Stream } from "effect";
import { join } from "node:path";
import { polarisHome } from "../paths.ts";
import type {
  TraceComparison,
  TraceCompareSelector,
  TraceDetail,
  TraceError,
  TraceFilter,
  SpanDetail,
} from "@polaris/protocol";
import type { IngestError, IngestContext } from "./ingest.ts";
import type { CompareTurns } from "./compareQuery.ts";
import type { TraceHistory, TraceView, TraceToolPage, TraceToolSpan } from "./workerProtocol.ts";
import type { TraceWorkerOptions } from "./workerClient.ts";
import type { TracePage } from "./store.ts";
import type { SpanStats, SpanStatsFilter } from "./stats.ts";
import type { SpanCapture, SpanCaptureFilter } from "./capture.ts";

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
      turns?: CompareTurns
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
    /** Spans grouped by name and/or service over a bounded window (the `trace_stats` tool). */
    readonly stats: (
      checkout: string,
      filter: SpanStatsFilter
    ) => Effect.Effect<SpanStats, TraceError>;
    /** The Spans that started in a window, oldest first (the `trace_capture` tool). */
    readonly capture: (
      checkout: string,
      filter: SpanCaptureFilter
    ) => Effect.Effect<SpanCapture, TraceError>;
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
    /** Subscribes now, in the scope; the stream then wakes on each later write or `notify`. */
    readonly changes: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
    readonly flush: Effect.Effect<void, TraceError>;
    /** Receiver/configuration changes wake existing watches without a polling loop. */
    readonly notify: Effect.Effect<void>;
    readonly workerRunning: Effect.Effect<boolean>;
  }
>()("polaris/traces/TraceStore") {
  static layerAt = (filename: string, options: TraceWorkerOptions = {}) =>
    Layer.unwrap(
      Effect.promise(() => import("./store.ts")).pipe(
        Effect.map((m) => m.traceStoreLayerAt(filename, options))
      )
    );
  static readonly layer = Layer.suspend(() =>
    TraceStore.layerAt(join(polarisHome(), "traces.sqlite"))
  );
}
