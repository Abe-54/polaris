/** Error Spans grouped by fingerprint for the `trace_errors` tool: one bounded scan of a window. */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { Schema } from "effect";
import { likeSubstring, STATS_SCAN_CAP } from "./stats.ts";

/** Span names kept per fingerprint, most frequent first. */
const TOP_NAMES = 3;

const MAX_FINGERPRINT = 200;

const MAX_MESSAGE = 500;

export const SpanErrorsFilter = Schema.Struct({
  /** Epoch milliseconds; Spans that started earlier are not read. */
  sinceMs: Schema.Number,
  /** Case-insensitive substring of the Span name. */
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  service: Schema.optionalKey(Schema.String),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});

export type SpanErrorsFilter = typeof SpanErrorsFilter.Type;

const Counted = Schema.Struct({ value: Schema.String, count: Schema.Number });

export const SpanErrorGroup = Schema.Struct({
  fingerprint: Schema.String,
  /** The newest raw message's first line. */
  message: Schema.String,
  count: Schema.Number,
  firstSeen: Schema.String,
  lastSeen: Schema.String,
  services: Schema.Array(Counted),
  /** The most frequent Span names, at most three; `nameCount` counts them all. */
  names: Schema.Array(Counted),
  nameCount: Schema.Number,
  /** The newest Span with this fingerprint. */
  example: Schema.Struct({ trace: Schema.String, span: Schema.String }),
});

export type SpanErrorGroup = typeof SpanErrorGroup.Type;

export const SpanErrors = Schema.Struct({
  fingerprints: Schema.Array(SpanErrorGroup),
  groupCount: Schema.Number,
  spans: Schema.Number,
  /** True when the cap stopped the scan; then only Spans from `coveredSince` on were read. */
  truncated: Schema.Boolean,
  coveredSince: Schema.NullOr(Schema.String),
});

export type SpanErrors = typeof SpanErrors.Type;

const Row = Schema.Struct({
  trace: Schema.String,
  span: Schema.String,
  name: Schema.String,
  service: Schema.String,
  message: Schema.String,
  age: Schema.Number,
});

type Row = typeof Row.Type;

const decodeRows = Schema.decodeUnknownSync(Schema.Array(Row));

/** The rules only ever see this much of a message, so a huge one costs no more than this. */
const MAX_SCANNED = 1_000;

/** Random ids: eight or more word characters with at least two digits and a letter. */
const randomId = (token: string) =>
  (token.match(/\d/g)?.length ?? 0) >= 2 && /[a-z]/i.test(token) ? "<id>" : token;

/** Replacements in order: quoted text first, so paths and ids inside quotes become `<str>`. */
const RULES: ReadonlyArray<readonly [RegExp, string | ((token: string) => string)]> = [
  [/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>"],
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?|\b[A-Z]:\\\S+/g, "<path>"],
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/[\w-]{8,}/g, randomId],
  [/\b\d+(?:\.\d+)?\b/g, "<n>"],
];

const firstLine = (message: string) =>
  message.trimStart().slice(0, MAX_SCANNED).split(/\r?\n/, 1)[0]!.trim();

/** The first line with ids, numbers, quoted text and paths replaced, so repeats share one key. */
export const fingerprint = (message: string): string =>
  RULES.reduce(
    (text, [pattern, token]) =>
      Schema.is(Schema.String)(token)
        ? text.replace(pattern, token)
        : text.replace(pattern, (match) => token(match)),
    firstLine(message)
  )
    .replace(/\s+/g, " ")
    .slice(0, MAX_FINGERPRINT);

const errorsQuery = (checkout: string, filter: SpanErrorsFilter, cap: number) => {
  const clauses = ["checkout=?", "status='error'", "age>=?"];
  const bindings: SQLQueryBindings[] = [checkout, Math.floor(filter.sinceMs)];

  if (filter.name !== undefined) {
    clauses.push("name LIKE ? ESCAPE '\\'");
    bindings.push(likeSubstring(filter.name));
  }

  if (filter.service !== undefined) {
    clauses.push("service=?");
    bindings.push(filter.service);
  }

  // An empty status message falls back to the first exception event's message.
  return {
    sql: `SELECT trace_id AS trace,id AS span,coalesce(name,'') AS name,service,age,coalesce(
      nullif(json_extract(value,'$.statusMessage'),''),
      (SELECT json_extract(e.value,'$.attributes."exception.message"') FROM json_each(s.value,'$.events') e
        WHERE json_extract(e.value,'$.name')='exception' LIMIT 1),
      '') AS message
      FROM spans s WHERE ${clauses.join(" AND ")} ORDER BY age DESC LIMIT ?`,
    bindings: [...bindings, cap + 1],
  };
};

interface Bucket {
  readonly newest: Row;
  oldest: number;
  count: number;
  readonly services: Map<string, number>;
  readonly names: Map<string, number>;
}

const bump = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

const ranked = (counts: Map<string, number>) =>
  [...counts]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value));

const groupOf = (key: string, bucket: Bucket): SpanErrorGroup => {
  const names = ranked(bucket.names);

  return {
    fingerprint: key,
    message: firstLine(bucket.newest.message).slice(0, MAX_MESSAGE),
    count: bucket.count,
    firstSeen: new Date(bucket.oldest).toISOString(),
    lastSeen: new Date(bucket.newest.age).toISOString(),
    services: ranked(bucket.services),
    names: names.slice(0, TOP_NAMES),
    nameCount: names.length,
    example: { trace: bucket.newest.trace, span: bucket.newest.span },
  };
};

/** Newest-first over `spans_age` (checkout, status, age): the window bounds the range, the cap the rows. */
export const spanErrors = (
  db: Database,
  checkout: string,
  filter: SpanErrorsFilter,
  cap = STATS_SCAN_CAP
): SpanErrors => {
  const query = errorsQuery(checkout, filter, cap);
  const rows = decodeRows(db.query(query.sql).all(...query.bindings));
  const truncated = rows.length > cap;
  const read = truncated ? rows.slice(0, cap) : rows;
  const buckets = new Map<string, Bucket>();

  for (const row of read) {
    const key = fingerprint(row.message);

    const bucket = buckets.get(key) ?? {
      newest: row,
      oldest: row.age,
      count: 0,
      services: new Map(),
      names: new Map(),
    };

    // Rows arrive newest first, so each new row is the oldest seen so far.
    bucket.oldest = row.age;
    bucket.count++;
    bump(bucket.services, row.service);
    bump(bucket.names, row.name);
    buckets.set(key, bucket);
  }

  const groups = [...buckets]
    .map(([key, bucket]) => groupOf(key, bucket))
    .toSorted((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));

  return {
    fingerprints: groups.slice(0, filter.limit),
    groupCount: groups.length,
    spans: read.length,
    truncated,
    coveredSince: truncated ? new Date(read.at(-1)!.age).toISOString() : null,
  };
};

/** The query plan, for the index check in tests. */
export const spanErrorsPlan = (db: Database, checkout: string, filter: SpanErrorsFilter) => {
  const query = errorsQuery(checkout, filter, STATS_SCAN_CAP);

  return Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ detail: Schema.String })))(
    db.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.bindings)
  ).map((row) => row.detail);
};
