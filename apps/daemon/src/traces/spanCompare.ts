/** Span groups (name and service) diffed between two windows or builds, for `trace_compare`. */
import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { AttributeFilters } from "./attributes.ts";
import { scanGroups, SpanStatsFilter, type SpanStatsGroup } from "./stats.ts";

/** A group whose largest relative change is under this counts as unchanged. */
export const CHANGE_THRESHOLD = 0.1;

export const SpanCompareSide = Schema.Struct({
  sinceMs: SpanStatsFilter.fields.sinceMs,
  untilMs: SpanStatsFilter.fields.untilMs,
  version: SpanStatsFilter.fields.version,
});

export type SpanCompareSide = typeof SpanCompareSide.Type;

export const SpanCompareFilter = Schema.Struct({
  a: SpanCompareSide,
  b: SpanCompareSide,
  name: SpanStatsFilter.fields.name,
  service: SpanStatsFilter.fields.service,
  attributes: Schema.optionalKey(AttributeFilters),
  limit: SpanStatsFilter.fields.limit,
});

export type SpanCompareFilter = typeof SpanCompareFilter.Type;

const Metrics = Schema.Struct({
  count: Schema.Number,
  errors: Schema.Number,
  /** errors / count, 0 to 1. */
  errorRate: Schema.Number,
  p95Ms: Schema.Number,
});

type Metrics = typeof Metrics.Type;

export const SpanGroupChange = Schema.Struct({
  name: Schema.String,
  service: Schema.String,
  change: Schema.Literals(["appeared", "disappeared", "changed"]),
  a: Schema.NullOr(Metrics),
  b: Schema.NullOr(Metrics),
  /** The largest of the relative share-of-spans, error-rate and p95 changes, 0 to 1. */
  score: Schema.Number,
  /** From B when the group is there, else from A. */
  example: Schema.Struct({ trace: Schema.String, span: Schema.String }),
});

export type SpanGroupChange = typeof SpanGroupChange.Type;

const SideRead = Schema.Struct({
  spans: Schema.Number,
  groups: Schema.Number,
  truncated: Schema.Boolean,
  coveredSince: Schema.NullOr(Schema.String),
});

export const SpanCompare = Schema.Struct({
  a: SideRead,
  b: SideRead,
  changes: Schema.Array(SpanGroupChange),
  appeared: Schema.Number,
  disappeared: Schema.Number,
  changed: Schema.Number,
  unchanged: Schema.Number,
});

export type SpanCompare = typeof SpanCompare.Type;

const metricsOf = (group: SpanStatsGroup): Metrics => ({
  count: group.count,
  errors: group.errors,
  errorRate: group.errors / group.count,
  p95Ms: group.p95Ms,
});

/** |x - y| / max(x, y), so 0 is equal and 1 is from or to nothing. */
const relative = (x: number, y: number) =>
  Math.max(x, y) === 0 ? 0 : Math.abs(x - y) / Math.max(x, y);

/** Count changes are compared as shares of each side's spans, so unequal windows still compare. */
const scoreOf = (a: Metrics, b: Metrics, totals: { a: number; b: number }) =>
  Math.max(
    relative(a.count / totals.a, b.count / totals.b),
    Math.abs(a.errorRate - b.errorRate),
    relative(a.p95Ms, b.p95Ms)
  );

const keyOf = (group: SpanStatsGroup) => JSON.stringify([group.name, group.service]);

const changeOf = (
  a: SpanStatsGroup | undefined,
  b: SpanStatsGroup | undefined,
  totals: { a: number; b: number }
): SpanGroupChange => {
  // SAFETY: every key comes from A's or B's groups, so at least one side is present.
  const present = (b ?? a)!;
  const before = a === undefined ? null : metricsOf(a);
  const after = b === undefined ? null : metricsOf(b);

  return {
    name: present.name ?? "",
    service: present.service ?? "",
    change: before === null ? "appeared" : after === null ? "disappeared" : "changed",
    a: before,
    b: after,
    score: before === null || after === null ? 1 : scoreOf(before, after, totals),
    example: { ...present.example },
  };
};

const bySize = (x: SpanGroupChange, y: SpanGroupChange) =>
  y.score - x.score ||
  (y.a?.count ?? 0) + (y.b?.count ?? 0) - ((x.a?.count ?? 0) + (x.b?.count ?? 0)) ||
  x.name.localeCompare(y.name);

const readOf = (scan: ReturnType<typeof scanGroups>) => ({
  spans: scan.spans,
  groups: scan.groupCount,
  truncated: scan.truncated,
  coveredSince: scan.coveredSince,
});

/** Two bounded window scans grouped by name and service, then diffed; largest change first. */
export const spanCompare = (
  db: Database,
  checkout: string,
  filter: SpanCompareFilter,
  cap?: number
): SpanCompare => {
  const { a, b, limit: _limit, ...shared } = filter;

  const scan = (side: SpanCompareSide) =>
    scanGroups(db, checkout, { ...shared, ...side, by: "both", sort: "count" }, cap);

  const before = scan(a);
  const after = scan(b);
  const totals = { a: Math.max(1, before.spans), b: Math.max(1, after.spans) };
  const left = new Map(before.groups.map((group) => [keyOf(group), group]));
  const right = new Map(after.groups.map((group) => [keyOf(group), group]));

  const all = [...new Set([...left.keys(), ...right.keys()])]
    .map((key) => changeOf(left.get(key), right.get(key), totals))
    .toSorted(bySize);

  const shown = all.filter((change) => change.score >= CHANGE_THRESHOLD);

  const count = (kind: SpanGroupChange["change"]) =>
    shown.filter((change) => change.change === kind).length;

  return {
    a: readOf(before),
    b: readOf(after),
    changes: shown.slice(0, filter.limit),
    appeared: count("appeared"),
    disappeared: count("disappeared"),
    changed: count("changed"),
    unchanged: all.length - shown.length,
  };
};
