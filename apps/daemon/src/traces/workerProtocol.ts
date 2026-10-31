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
} from "@polaris/protocol";
import { IngestContext } from "./ingest.ts";

const OnCheckout = { checkout: Schema.String };

export const TraceWorkerRequest = Schema.TaggedUnion({
  Open: {
    filename: Schema.String,
    maxBytes: Schema.Number,
    maxAgeMs: Schema.Number,
    flushMs: Schema.Number,
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
    baselineStart: Schema.optionalKey(Schema.String),
  },
  List: { ...OnCheckout, filter: TraceFilter },
  Get: { ...OnCheckout, traceId: TraceIdPrefix },
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

export const TraceWorkerValue = Schema.Union([
  Schema.Null,
  Schema.Number,
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
