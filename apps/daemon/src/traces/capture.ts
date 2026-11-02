/** Span capture for the `trace_capture` tool: the Spans that started in a window, oldest first. */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { Schema } from "effect";
import { likeSubstring } from "./stats.ts";

/** At most this many Spans are read per capture; the rest are reported as truncated. */
export const CAPTURE_SPAN_CAP = 500;

export const SpanCaptureFilter = Schema.Struct({
  /** Epoch milliseconds, inclusive: Spans that started earlier are not read. */
  sinceMs: Schema.Number,
  /** Epoch milliseconds, inclusive: Spans that started later are not read. */
  untilMs: Schema.Number,
  /** Case-insensitive substring of the Span name. */
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  cap: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CAPTURE_SPAN_CAP })),
});

export type SpanCaptureFilter = typeof SpanCaptureFilter.Type;

export const CapturedSpan = Schema.Struct({
  trace: Schema.String,
  span: Schema.String,
  parent: Schema.NullOr(Schema.String),
  name: Schema.String,
  service: Schema.String,
  error: Schema.Number,
  duration: Schema.Number,
  /** Start in Unix nanoseconds, zero-padded so it sorts as text. */
  start: Schema.String,
});

export type CapturedSpan = typeof CapturedSpan.Type;

export const SpanCapture = Schema.Struct({
  spans: Schema.Array(CapturedSpan),
  /** True when more Spans started in the window than the cap; the oldest are kept. */
  truncated: Schema.Boolean,
});

export type SpanCapture = typeof SpanCapture.Type;

const decodeRows = Schema.decodeUnknownSync(Schema.Array(CapturedSpan));

const captureQuery = (checkout: string, filter: SpanCaptureFilter) => {
  const clauses = ["checkout=?", "age>=?", "age<=?"];

  const bindings: SQLQueryBindings[] = [
    checkout,
    Math.floor(filter.sinceMs),
    Math.ceil(filter.untilMs),
  ];

  if (filter.name !== undefined) {
    clauses.push("name LIKE ? ESCAPE '\\'");
    bindings.push(likeSubstring(filter.name));
  }

  return {
    sql: `SELECT trace_id AS trace,id AS span,parent,coalesce(name,'') AS name,service,status='error' AS error,
      coalesce(duration,0) AS duration,start FROM spans WHERE ${clauses.join(" AND ")} ORDER BY age LIMIT ?`,
    bindings: [...bindings, filter.cap + 1],
  };
};

/** Oldest first over `spans_retention` (checkout, age): the window bounds the range, the cap the rows. */
export const spanCapture = (
  db: Database,
  checkout: string,
  filter: SpanCaptureFilter
): SpanCapture => {
  const query = captureQuery(checkout, filter);
  const rows = decodeRows(db.query(query.sql).all(...query.bindings));

  return { spans: rows.slice(0, filter.cap), truncated: rows.length > filter.cap };
};

/** The query plan, for the index check in tests. */
export const spanCapturePlan = (db: Database, checkout: string, filter: SpanCaptureFilter) => {
  const query = captureQuery(checkout, filter);

  return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ detail: Schema.String })))(
    db.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)
  ).map((row) => row.detail);
};
