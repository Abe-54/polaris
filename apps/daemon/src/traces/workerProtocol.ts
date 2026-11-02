import { Schema } from "effect";
import {
  TraceError,
  TraceComparison,
  TraceCompareSelector,
  TraceFilter,
  TraceIdPrefix,
  SpanIdPrefix,
  TraceSummary,
  TraceDetail,
  SpanDetail,
  Span,
} from "@polaris/protocol";
import { IngestContext } from "./ingest.ts";
import { SpanCapture, SpanCaptureFilter } from "./capture.ts";
import { SpanStats, SpanStatsFilter } from "./stats.ts";

const OnCheckout = { checkout: Schema.String };

export const TraceWorkerRequest = Schema.TaggedUnion({
  Open: {
    filename: Schema.String,
    maxBytes: Schema.Number,
    maxAgeMs: Schema.Number,
    flushMs: Schema.Number,
    selfMaxBytes: Schema.Number,
  },
  Ingest: {
    bytes: Schema.Uint8Array,
    signal: Schema.Literals(["traces", "logs"]),
    contentType: Schema.Literals(["application/json", "application/x-protobuf"]),
    context: IngestContext,
  },
  Compare: {
    ...OnCheckout,
    a: TraceCompareSelector,
    b: TraceCompareSelector,
    /** Baseline's start, and the Turn ids each Turn or Turns side resolved to, in order. */
    turns: Schema.optionalKey(
      Schema.Struct({
        baselineStart: Schema.optionalKey(Schema.String),
        a: Schema.optionalKey(Schema.Array(Schema.String)),
        b: Schema.optionalKey(Schema.Array(Schema.String)),
      })
    ),
  },
  List: { ...OnCheckout, filter: TraceFilter },
  Overlap: { ...OnCheckout, start: Schema.String, end: Schema.String },
  Get: { ...OnCheckout, traceId: TraceIdPrefix },
  View: {
    ...OnCheckout,
    traceId: TraceIdPrefix,
    focus: Schema.Literals(["slow", "errors", "all"]),
  },
  ToolList: { ...OnCheckout, filter: TraceFilter },
  ToolSpan: { ...OnCheckout, traceId: TraceIdPrefix, spanId: SpanIdPrefix },
  Stats: { ...OnCheckout, filter: SpanStatsFilter },
  Capture: { ...OnCheckout, filter: SpanCaptureFilter },
  History: { ...OnCheckout, traceId: TraceIdPrefix, includeSpans: Schema.Boolean },
  Span: { ...OnCheckout, traceId: TraceIdPrefix, spanId: SpanIdPrefix },
  Link: { ...OnCheckout, traceId: TraceIdPrefix },
  Flush: {},
  Close: {},
});

export type TraceWorkerRequest = typeof TraceWorkerRequest.Type;

export const TraceWorkerMessage = Schema.Struct({ id: Schema.Number, request: TraceWorkerRequest });

export const TracePageSchema = Schema.Struct({
  traces: Schema.Array(TraceSummary),
  total: Schema.Number,
});

export const TraceHistory = Schema.Struct({
  root: Schema.NullOr(Schema.Number),
  spans: Schema.Record(Schema.String, Schema.Number),
  samples: Schema.Record(Schema.String, Schema.Number),
});

export type TraceHistory = typeof TraceHistory.Type;

export const TraceView = Schema.Struct({
  text: Schema.String,
  data: Schema.Struct({
    summary: TraceSummary,
    spans: Schema.Array(Span),
    groups: Schema.Array(Schema.Struct({ spanIds: Schema.Array(Schema.String) })),
    folded: Schema.Struct({ count: Schema.Number, underMs: Schema.Number }),
  }),
});

export type TraceView = typeof TraceView.Type;

export const TraceToolPage = Schema.Struct({
  ...TracePageSchema.fields,
  history: Schema.Record(Schema.String, Schema.Number),
  errors: Schema.Record(Schema.String, Schema.String),
});

export type TraceToolPage = typeof TraceToolPage.Type;

export const TraceToolSpan = Schema.Struct({ detail: SpanDetail, start: Schema.String });

export type TraceToolSpan = typeof TraceToolSpan.Type;

export const TraceWorkerValue = Schema.Union([
  Schema.Null,
  Schema.Number,
  TraceToolPage,
  TraceView,
  TraceToolSpan,
  SpanStats,
  SpanCapture,
  TracePageSchema,
  TraceDetail,
  SpanDetail,
  TraceHistory,
  TraceComparison,
]);

export type TraceWorkerValue = typeof TraceWorkerValue.Type;

export const TraceWorkerReply = Schema.TaggedUnion({
  Success: { id: Schema.Number, value: TraceWorkerValue },
  Failure: {
    id: Schema.Number,
    status: Schema.Number,
    error: Schema.Struct({
      code: TraceError.fields.code,
      message: Schema.String,
      fix: Schema.String,
    }),
  },
  Changed: {},
});

export type TraceWorkerReply = typeof TraceWorkerReply.Type;
