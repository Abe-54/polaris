/** Span aggregation for the `trace_stats` tool: one bounded, index-ordered scan of a time window. */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { Match, Schema } from "effect";
import { AttributeFilters, AttributeKey, attributeClauses, attributePath } from "./attributes.ts";

/** At most this many matching Spans, newest first, are aggregated per call. */
export const STATS_SCAN_CAP = 20_000;

export const SpanStatsFilter = Schema.Struct({
  /** Epoch milliseconds; Spans that started earlier are not read. */
  sinceMs: Schema.Number,
  /** Case-insensitive substring of the Span name. */
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  service: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["error", "ok"])),
  /** Span attribute equalities, all of which must hold. */
  attributes: Schema.optionalKey(AttributeFilters),
  /** `none` groups by `attribute` alone. */
  by: Schema.Literals(["name", "service", "both", "none"]),
  /** Also groups by this Span attribute's value. */
  attribute: Schema.optionalKey(AttributeKey),
  sort: Schema.Literals(["count", "errors", "slow"]),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});

export type SpanStatsFilter = typeof SpanStatsFilter.Type;

const AttributeValue = Schema.NullOr(Schema.Union([Schema.String, Schema.Number]));

export const SpanStatsGroup = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  service: Schema.optionalKey(Schema.String),
  /** The grouped attribute's value, null where a Span lacks it; present only with `attribute`. */
  attribute: Schema.optionalKey(AttributeValue),
  count: Schema.Number,
  errors: Schema.Number,
  p50Ms: Schema.Number,
  p95Ms: Schema.Number,
  maxMs: Schema.Number,
  latestStart: Schema.String,
  /** The newest errored Span when the group has errors, else its slowest. */
  example: Schema.Struct({ trace: Schema.String, span: Schema.String }),
});

export type SpanStatsGroup = typeof SpanStatsGroup.Type;

export const SpanStats = Schema.Struct({
  groups: Schema.Array(SpanStatsGroup),
  groupCount: Schema.Number,
  spans: Schema.Number,
  /** True when the cap stopped the scan; then only Spans from `coveredSince` on were read. */
  truncated: Schema.Boolean,
  coveredSince: Schema.NullOr(Schema.String),
});

export type SpanStats = typeof SpanStats.Type;

const Row = Schema.Struct({
  trace: Schema.String,
  span: Schema.String,
  name: Schema.String,
  service: Schema.String,
  error: Schema.Number,
  duration: Schema.Number,
  age: Schema.Number,
  attribute: AttributeValue,
});

type Row = typeof Row.Type;

const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row));

export const likeSubstring = (value: string) =>
  `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

const statsQuery = (checkout: string, filter: SpanStatsFilter, cap: number) => {
  const clauses = ["checkout=?", "age>=?"];
  const bindings: SQLQueryBindings[] = [checkout, Math.floor(filter.sinceMs)];

  if (filter.name !== undefined) {
    clauses.push("name LIKE ? ESCAPE '\\'");
    bindings.push(likeSubstring(filter.name));
  }

  if (filter.service !== undefined) {
    clauses.push("service=?");
    bindings.push(filter.service);
  }

  if (filter.status !== undefined)
    clauses.push(filter.status === "error" ? "status='error'" : "status<>'error'");
  const attributes = attributeClauses(filter.attributes);
  const grouped = filter.attribute === undefined ? [] : [attributePath(filter.attribute)];

  return {
    sql: `SELECT trace_id AS trace,id AS span,coalesce(name,'') AS name,service,status='error' AS error,
      coalesce(duration,0) AS duration,age,${grouped.length > 0 ? "json_extract(value,?)" : "NULL"} AS attribute
      FROM spans WHERE ${[...clauses, ...attributes.clauses].join(" AND ")} ORDER BY age DESC LIMIT ?`,
    bindings: [...grouped, ...bindings, ...attributes.bindings, cap + 1],
  };
};

interface Bucket {
  readonly name: string;
  readonly service: string;
  readonly attribute: Row["attribute"];
  readonly durations: number[];
  errors: number;
  latest: number;
  error: Row | null;
  slowest: Row;
}

const byName = (filter: SpanStatsFilter) => filter.by === "name" || filter.by === "both";

const byService = (filter: SpanStatsFilter) => filter.by === "service" || filter.by === "both";

const keyOf = (filter: SpanStatsFilter, row: Row) =>
  JSON.stringify([
    byName(filter) ? row.name : null,
    byService(filter) ? row.service : null,
    filter.attribute === undefined ? null : row.attribute,
  ]);

const add = (buckets: Map<string, Bucket>, filter: SpanStatsFilter, row: Row) => {
  const key = keyOf(filter, row);
  const bucket = buckets.get(key);

  if (bucket === undefined) {
    buckets.set(key, {
      name: row.name,
      service: row.service,
      attribute: row.attribute,
      durations: [row.duration],
      errors: row.error,
      latest: row.age,
      error: row.error ? row : null,
      slowest: row,
    });

    return;
  }

  bucket.durations.push(row.duration);
  bucket.errors += row.error;

  // Rows arrive newest first, so the first error seen is the newest one.
  if (row.error && bucket.error === null) bucket.error = row;

  if (row.duration > bucket.slowest.duration) bucket.slowest = row;
};

const nearestRank = (sorted: ReadonlyArray<number>, rank: number) =>
  sorted[Math.max(0, Math.ceil(sorted.length * rank) - 1)]!;

const groupOf = (filter: SpanStatsFilter, bucket: Bucket): SpanStatsGroup => {
  const sorted = bucket.durations.toSorted((a, b) => a - b);
  const example = bucket.error ?? bucket.slowest;

  return {
    ...(byName(filter) ? { name: bucket.name } : undefined),
    ...(byService(filter) ? { service: bucket.service } : undefined),
    ...(filter.attribute === undefined ? undefined : { attribute: bucket.attribute }),
    count: sorted.length,
    errors: bucket.errors,
    p50Ms: nearestRank(sorted, 0.5),
    p95Ms: nearestRank(sorted, 0.95),
    maxMs: sorted.at(-1)!,
    latestStart: new Date(bucket.latest).toISOString(),
    example: { trace: example.trace, span: example.span },
  };
};

const order = (sort: SpanStatsFilter["sort"]) => (a: SpanStatsGroup, b: SpanStatsGroup) => {
  const primary = Match.value(sort).pipe(
    Match.when("errors", () => b.errors - a.errors),
    Match.when("slow", () => b.p95Ms - a.p95Ms),
    Match.orElse(() => 0)
  );

  return (
    primary ||
    b.count - a.count ||
    b.errors - a.errors ||
    (a.name ?? "").localeCompare(b.name ?? "") ||
    String(a.attribute ?? "").localeCompare(String(b.attribute ?? ""))
  );
};

/** Newest-first over `spans_retention` (checkout, age): the window bounds the range, the cap the rows. */
export const spanStats = (
  db: Database,
  checkout: string,
  filter: SpanStatsFilter,
  cap = STATS_SCAN_CAP
): SpanStats => {
  const query = statsQuery(checkout, filter, cap);
  const rows = decodeRows(db.query(query.sql).all(...query.bindings));
  const truncated = rows.length > cap;
  const read = truncated ? rows.slice(0, cap) : rows;
  const buckets = new Map<string, Bucket>();

  for (const row of read) add(buckets, filter, row);

  const groups = [...buckets.values()]
    .map((bucket) => groupOf(filter, bucket))
    .toSorted(order(filter.sort));

  return {
    groups: groups.slice(0, filter.limit),
    groupCount: groups.length,
    spans: read.length,
    truncated,
    coveredSince: truncated ? new Date(read.at(-1)!.age).toISOString() : null,
  };
};

/** The query plan, for the index check in tests. */
export const spanStatsPlan = (db: Database, checkout: string, filter: SpanStatsFilter) => {
  const query = statsQuery(checkout, filter, STATS_SCAN_CAP);

  return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ detail: Schema.String })))(
    db.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)
  ).map((row) => row.detail);
};
