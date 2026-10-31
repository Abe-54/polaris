/** Checkout-scoped Traces (ADR 0094, ENG-656). Clients call these RPCs only with capability `traces`. */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Unsupported } from "./errors.ts";
import { SessionId, Timestamp, TurnId, WorkspaceId } from "./ids.ts";

export const TRACES_CAPABILITY = "traces";

/** Lowercase OTLP hex identifiers, without a prefix. */
export const TraceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));

export const SpanId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/));

export const TraceIdPrefix = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8,32}$/));

export const SpanIdPrefix = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8,16}$/));

/** Exact Unix nanoseconds as a decimal string; never round through a JavaScript number. */
export const TraceNanoseconds = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]*)$/));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/** OTLP status. A summary is `error` if any retained Span has error status. */
export const TraceStatus = Schema.Literals(["unset", "ok", "error"]);

export type TraceStatus = typeof TraceStatus.Type;

/** Redacted OTLP attributes. int64 values are decimal strings; bytes are base64 strings. */
export const TraceAttributes = Schema.Record(Schema.String, Schema.Json);

export type TraceAttributes = typeof TraceAttributes.Type;

/** A Turn's stable id and displayed number in its Agent Session. Null attribution means between Turns. */
export const TraceTurn = Schema.Struct({
  sessionId: SessionId,
  id: TurnId,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export type TraceTurn = typeof TraceTurn.Type;

export const TraceAttribution = Schema.Struct({
  /** Canonical checkout path, resolved by the Daemon from the ingest token. */
  checkout: Schema.String,
  workspaceId: WorkspaceId,
  /** Null for a Polaris terminal belonging to the Workspace. */
  sessionId: Schema.NullOr(SessionId),
  /** Turn active when this Span started, not when the batch arrived. Null means between Turns. */
  turn: Schema.NullOr(TraceTurn),
  /** Turn that launched the exporting process; null for a user terminal or unknown launch. */
  launchedTurn: Schema.NullOr(TraceTurn),
});

export type TraceAttribution = typeof TraceAttribution.Type;

export const TraceScope = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  attributes: TraceAttributes,
});

export const SpanEvent = Schema.Struct({
  name: Schema.String,
  timeUnixNano: TraceNanoseconds,
  attributes: TraceAttributes,
  droppedAttributes: Count,
});

export const SpanLink = Schema.Struct({
  traceId: TraceId,
  spanId: SpanId,
  traceState: Schema.String,
  attributes: TraceAttributes,
  droppedAttributes: Count,
});

/** One timed step. Arrays contain retained records; dropped counts are reported by the exporter. */
export const Span = Schema.Struct({
  traceId: TraceId,
  id: SpanId,
  parentId: Schema.NullOr(SpanId),
  name: Schema.String,
  kind: Schema.Literals(["unspecified", "internal", "server", "client", "producer", "consumer"]),
  service: Schema.String,
  status: TraceStatus,
  statusMessage: Schema.String,
  traceState: Schema.String,
  startTimeUnixNano: TraceNanoseconds,
  endTimeUnixNano: TraceNanoseconds,
  /** Derived milliseconds for display; exact times above remain authoritative. */
  durationMs: Milliseconds,
  attributes: TraceAttributes,
  resource: TraceAttributes,
  scope: TraceScope,
  polaris: TraceAttribution,
  events: Schema.Array(SpanEvent),
  links: Schema.Array(SpanLink),
  droppedAttributes: Count,
  droppedEvents: Count,
  droppedLinks: Count,
});

export type Span = typeof Span.Type;

/** An OTLP log record. Null ids mean the exporter did not correlate it with a Span. */
export const LogRecord = Schema.Struct({
  /** Stable store-assigned id, used to deduplicate records across reads. */
  id: Schema.String,
  traceId: Schema.NullOr(TraceId),
  spanId: Schema.NullOr(SpanId),
  timeUnixNano: TraceNanoseconds,
  observedTimeUnixNano: TraceNanoseconds,
  severityNumber: Count,
  severityText: Schema.String,
  body: Schema.Json,
  attributes: TraceAttributes,
  resource: TraceAttributes,
  scope: TraceScope,
  polaris: TraceAttribution,
  droppedAttributes: Count,
});

export type LogRecord = typeof LogRecord.Type;

/** One operation in a checkout. Counts and duration describe retained Spans, including partial traces. */
export const TraceSummary = Schema.Struct({
  id: TraceId,
  /** Root name and id; earliest retained Span when the exporter has not sent a root. */
  root: Schema.String,
  rootSpanId: SpanId,
  service: Schema.String,
  startedAt: Timestamp,
  startTimeUnixNano: TraceNanoseconds,
  durationMs: Milliseconds,
  spans: Count,
  /** Unique service names in alphabetical order. */
  services: Schema.Array(Schema.String),
  errors: Count,
  status: TraceStatus,
  /** Attribution of the root (or earliest retained Span). */
  turn: Schema.NullOr(TraceTurn),
  sessionId: Schema.NullOr(SessionId),
  /** Explicit retention link, distinct from automatic Turn attribution. */
  linked: Schema.Boolean,
  /** True if known Spans were removed by retention. Missing upstream parents alone do not set this. */
  partial: Schema.Boolean,
});

export type TraceSummary = typeof TraceSummary.Type;

export const TraceDetail = Schema.Struct({
  summary: TraceSummary,
  /** All retained Spans, in start-time order with id as the tie-breaker. */
  spans: Schema.Array(Span),
});

export type TraceDetail = typeof TraceDetail.Type;

export const SpanDetail = Schema.Struct({
  span: Span,
  /** At most 20 matching records, newest first. */
  logs: Schema.Array(LogRecord).check(Schema.isMaxLength(20)),
  /** Total matching retained log records, before the 20-record limit. */
  logCount: Count,
});

export type SpanDetail = typeof SpanDetail.Type;

export const TraceAvailability = Schema.TaggedUnion({
  Listening: {},
  Unavailable: { code: Schema.String, message: Schema.String, owner: Schema.NullOr(Schema.String) },
});

export type TraceAvailability = typeof TraceAvailability.Type;

/** Snapshot replaces the previous one. A watch emits immediately, then only after changes. */
export const TracesSnapshot = Schema.Struct({
  availability: TraceAvailability,
  /** True when the user's exporter endpoint prevented injection for this Agent Session. */
  userExported: Schema.Boolean,
  /** This session's token-bearing base URL, or null when unavailable/user-exported. Never persist it. */
  endpoint: Schema.NullOr(Schema.String),
  traces: Schema.Array(TraceSummary),
  /** Number matching the filters before the limit. */
  total: Count,
});

export type TracesSnapshot = typeof TracesSnapshot.Type;

/** Omitted turn means all Turns. Null selects between Turns; an id selects that exact Turn. */
export const TraceFilter = Schema.Struct({
  turn: Schema.optionalKey(Schema.NullOr(TurnId)),
  /** Glob against the root name; only * and ? are special. */
  route: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  service: Schema.optionalKey(Schema.String),
  /** `ok` includes unset status; `error` means at least one error Span. */
  status: Schema.optionalKey(Schema.Literals(["ok", "error"])),
  minMs: Schema.optionalKey(Milliseconds),
  /** Defaults to 50; newest start time first, trace id breaks ties. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});

export type TraceFilter = typeof TraceFilter.Type;

export class TraceError extends Schema.TaggedError<TraceError>()("TraceError", {
  code: Schema.Literals([
    "E-TRACE-NOT-FOUND",
    "E-TRACE-AMBIGUOUS",
    "E-TRACE-NONE",
    "E-TRACE-UNAVAILABLE",
  ]),
  message: Schema.String,
  fix: Schema.String,
}) {}

const Errors = Schema.Union([TraceError, Unsupported]);

/** All reads resolve sessionId to its checkout on the Daemon; callers never supply a checkout path. */
export const WatchTraces = Rpc.make("traces.watch", {
  payload: { sessionId: SessionId, filter: Schema.optionalKey(TraceFilter) },
  success: TracesSnapshot,
  error: Errors,
  stream: true,
});

export const GetTrace = Rpc.make("traces.get", {
  payload: { sessionId: SessionId, traceId: TraceIdPrefix },
  success: TraceDetail,
  error: Errors,
});

export const GetSpan = Rpc.make("traces.span", {
  payload: { sessionId: SessionId, traceId: TraceIdPrefix, spanId: SpanIdPrefix },
  success: SpanDetail,
  error: Errors,
});

export class TracesRpcs extends RpcGroup.make(WatchTraces, GetTrace, GetSpan) {}
