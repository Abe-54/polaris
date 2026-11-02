/** Span attribute equality filters and group keys for the trace tools, read with `json_extract`. */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { Schema } from "effect";

/** At most this many attribute filters per call. */
export const MAX_ATTRIBUTE_FILTERS = 5;

/**
 * OpenTelemetry-style keys only (`db.system.name`, `http.route`). The charset excludes quotes and
 * backslashes, so a key can't break out of the JSON path it's placed in.
 */
export const AttributeKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,128}$/));

export const AttributeFilter = Schema.Struct({
  key: AttributeKey,
  /** Numbers also match OTLP int64 values, which are stored as decimal strings. */
  value: Schema.Union([
    Schema.String.check(Schema.isMaxLength(1024)),
    Schema.Finite,
    Schema.Boolean,
  ]),
});

export type AttributeFilter = typeof AttributeFilter.Type;

export const AttributeFilters = Schema.Array(AttributeFilter).check(
  Schema.isMaxLength(MAX_ATTRIBUTE_FILTERS)
);

export type AttributeFilters = typeof AttributeFilters.Type;

/** The JSON path of a Span attribute; always bound as a parameter, never spliced into SQL. */
export const attributePath = (key: string) => `$.attributes."${key}"`;

const typed = (value: AttributeFilter["value"]): SQLQueryBindings =>
  Schema.is(Schema.Boolean)(value) ? Number(value) : value;

/** One `json_extract(value,?) IN (?,?)` clause per filter, over the `spans.value` JSON. */
export const attributeClauses = (filters: AttributeFilters = [], column = "value") => ({
  clauses: filters.map(() => `json_extract(${column},?) IN (?,?)`),
  bindings: filters.flatMap((filter): SQLQueryBindings[] => [
    attributePath(filter.key),
    typed(filter.value),
    String(filter.value),
  ]),
});

/** `traces` has no window, so its attribute filters read only the newest this many Spans. */
export const TRACES_ATTRIBUTE_SCAN = 20_000;

/** Trace ids with a Span matching every filter among the checkout's newest Spans. */
export const attributeTraces = (
  checkout: string,
  filters: AttributeFilters,
  scan = TRACES_ATTRIBUTE_SCAN
) => {
  const matched = attributeClauses(filters, "r.value");

  // The LIMIT keeps SQLite from flattening the subquery, so the filter runs on the newest rows only.
  return {
    sql: `s.trace_id IN (SELECT r.trace_id FROM (
      SELECT trace_id,value FROM spans WHERE checkout=? ORDER BY age DESC LIMIT ?
    ) r WHERE ${matched.clauses.join(" AND ")})`,
    bindings: [checkout, scan, ...matched.bindings],
  };
};

const decodeAges = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ age: Schema.Number })));

/** Where an attribute-filtered `traces` read stopped, or null when it read every Span. */
export const attributeCoverage = (db: Database, checkout: string, scan = TRACES_ATTRIBUTE_SCAN) => {
  const ages = decodeAges(
    db
      .query("SELECT age FROM spans WHERE checkout=? ORDER BY age DESC LIMIT 2 OFFSET ?")
      .all(checkout, scan - 1)
  );

  return ages.length === 2 ? new Date(ages[0]!.age).toISOString() : null;
};
