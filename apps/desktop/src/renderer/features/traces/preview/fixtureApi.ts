/**
 * A `TracesApi` over the fixtures, for `<TracesLayer api={fixtureTracesApi(scene)}>` in previews
 * and tests. Filters, ordering, limits and id prefixes follow the protocol's documented rules.
 */
import type {
  TraceCompareSelector,
  TraceComparison,
  TraceDetail,
  TraceFilter,
  TraceRouteStats,
  TraceSummary,
  TracesSnapshot,
} from "@polaris/protocol";
import { Match } from "effect";
import type { Result } from "../../../../shared/api.ts";
import type { TracesApi } from "../data/api.ts";
import {
  FIXTURE_DETAILS,
  FIXTURE_LOGS,
  FIXTURE_SNAPSHOTS,
  FIXTURE_TURNS,
  type TracesScene,
} from "./fixtures.ts";

const DEFAULT_LIMIT = 50;

const LOG_LIMIT = 20;

const WILDCARDS = new Map([
  ["*", ".*"],
  ["?", "."],
]);

/** `*` and `?` are the only special characters (TraceFilter.route); the rest match themselves. */
const glob = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\/]/g, (c) => WILDCARDS.get(c) ?? `\\${c}`)}$`);

const matchesTurn = (t: TraceSummary, turn: TraceFilter["turn"]) =>
  turn === undefined || (turn === null ? t.turn === null : t.turn?.id === turn);

const matches = (t: TraceSummary, filter: TraceFilter) =>
  matchesTurn(t, filter.turn) &&
  (filter.route === undefined || glob(filter.route).test(t.root)) &&
  (filter.service === undefined || t.services.includes(filter.service)) &&
  (filter.status === undefined || (filter.status === "error") === t.errors > 0) &&
  (filter.minMs === undefined || t.durationMs >= filter.minMs);

/** Newest start first; the trace id breaks ties. */
const newestFirst = (a: TraceSummary, b: TraceSummary) => {
  const delta = BigInt(b.startTimeUnixNano) - BigInt(a.startTimeUnixNano);

  if (delta !== 0n) return delta < 0n ? -1 : 1;

  return a.id < b.id ? -1 : 1;
};

const details = (scene: TracesScene) =>
  scene === "traces" || scene === "unavailableStored" ? FIXTURE_DETAILS : [];

/** The snapshot `traces.watch` would emit for `filter` in `scene`. */
export const fixtureSnapshot = (scene: TracesScene, filter: TraceFilter = {}): TracesSnapshot => {
  const matched = details(scene)
    .map((d) => d.summary)
    .filter((t) => matches(t, filter))
    .sort(newestFirst);

  return {
    ...FIXTURE_SNAPSHOTS[scene],
    traces: matched.slice(0, filter.limit ?? DEFAULT_LIMIT),
    total: matched.length,
  };
};

const fail = (code: string, message: string, fix: string): Result<never> => ({
  ok: false,
  error: { code, message, fix },
});

/** One trace by a unique id prefix, or the E-TRACE error the Daemon would give. */
export const findTrace = (scene: TracesScene, prefix: string): Result<TraceDetail> => {
  const found = details(scene).filter((d) => d.summary.id.startsWith(prefix));
  const only = found[0];

  if (only === undefined)
    return fail("E-TRACE-NOT-FOUND", `No trace ${prefix} in this checkout`, "List traces again");

  if (found.length > 1)
    return fail(
      "E-TRACE-AMBIGUOUS",
      `${found.length} traces start with ${prefix}`,
      "Use more of the id"
    );

  return { ok: true, value: only };
};

/** Nearest-rank percentile `p` (0–100) of `values`; null with no values. */
export const nearestRank = (values: ReadonlyArray<number>, p: number): number | null => {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted.length === 0
    ? null
    : (sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null);
};

const stats = (traces: ReadonlyArray<TraceSummary>): TraceRouteStats => {
  const ms = traces.map((t) => t.durationMs);

  return { p50Ms: nearestRank(ms, 50), p95Ms: nearestRank(ms, 95), count: ms.length };
};

/** A selector's traces: a Turn's attributed ones (an unknown Turn fails), or one trace. */
const selected = (
  scene: TracesScene,
  selector: TraceCompareSelector
): Result<ReadonlyArray<TraceSummary>> =>
  Match.valueTags(selector, {
    Baseline: () =>
      fail(
        "E-INPUT",
        "This preview requires explicit comparison selectors.",
        "Use two Turn selectors or two Trace selectors."
      ),
    Turn: ({ turnId }): Result<ReadonlyArray<TraceSummary>> => {
      const traces = details(scene).filter((d) => d.summary.turn?.id === turnId);

      return traces.length === 0 && !Object.values(FIXTURE_TURNS).some((t) => t.id === turnId)
        ? fail("E-TRACE-NOT-FOUND", `No turn ${turnId} in this session`, "Pick another turn")
        : { ok: true, value: traces.map((d) => d.summary) };
    },
    Trace: ({ traceId }): Result<ReadonlyArray<TraceSummary>> => {
      const trace = findTrace(scene, traceId);

      return trace.ok ? { ok: true, value: [trace.value.summary] } : trace;
    },
  });

const routeKey = (t: TraceSummary) => `${t.service}\u0000${t.root}`;

/** What `traces.compare` would answer: every service and root on either side, sorted. */
export const fixtureComparison = (
  scene: TracesScene,
  a: TraceCompareSelector,
  b: TraceCompareSelector
): Result<TraceComparison> => {
  const before = selected(scene, a);
  const after = selected(scene, b);

  if (!before.ok) return before;

  if (!after.ok) return after;
  const keys = new Map([...before.value, ...after.value].map((t) => [routeKey(t), t]));

  const routes = [...keys.values()]
    .map((t) => ({
      service: t.service,
      route: t.root,
      before: stats(before.value.filter((x) => routeKey(x) === routeKey(t))),
      after: stats(after.value.filter((x) => routeKey(x) === routeKey(t))),
    }))
    .toSorted((x, y) =>
      x.service === y.service ? x.route.localeCompare(y.route) : x.service.localeCompare(y.service)
    );

  return { ok: true, value: { a, b, routes } };
};

export const fixtureTracesApi = (scene: TracesScene = "traces"): TracesApi => ({
  watch: (_at, filter, on) => {
    on.next(fixtureSnapshot(scene, filter));

    return () => undefined;
  },
  get: (_at, traceId) => Promise.resolve(findTrace(scene, traceId)),
  span: (_at, traceId, spanId) => {
    const trace = findTrace(scene, traceId);

    if (!trace.ok) return Promise.resolve(trace);
    const span = trace.value.spans.find((s) => s.id.startsWith(spanId));

    if (span === undefined)
      return Promise.resolve(
        fail("E-TRACE-NOT-FOUND", `No span ${spanId} in trace ${traceId}`, "Open the trace again")
      );
    const logs = FIXTURE_LOGS.filter((l) => l.spanId === span.id).toReversed();

    return Promise.resolve({
      ok: true,
      value: { span, logs: logs.slice(0, LOG_LIMIT), logCount: logs.length },
    });
  },
  compare: (_at, a, b) => Promise.resolve(fixtureComparison(scene, a, b)),
});
