/**
 * A `TracesApi` over the fixtures, for `<TracesLayer api={fixtureTracesApi(scene)}>` in previews
 * and tests. Filters, ordering, limits and id prefixes follow the protocol's documented rules.
 */
import {
  TraceCompareSelector,
  type TraceComparison,
  type TraceDetail,
  type TraceFilter,
  type TraceRouteStats,
  type TraceSummary,
  type TracesSnapshot,
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

/** The Daemon's rule: fewer than three complete runs on either side gives no percentiles. */
const MIN_RUNS = 3;

const stats = (traces: ReadonlyArray<TraceSummary>, enough: boolean): TraceRouteStats => {
  const ms = traces.map((t) => t.durationMs);

  return enough
    ? { p50Ms: nearestRank(ms, 50), p95Ms: nearestRank(ms, 95), count: ms.length }
    : { p50Ms: null, p95Ms: null, count: ms.length };
};

const notFound = (turnId: string) =>
  fail("E-TRACE-NOT-FOUND", `No turn ${turnId} in this session`, "Pick another turn");

const baselineMisplaced = () =>
  fail("E-INPUT", "Baseline can only be a, against a turn.", "Send a turn as b");

const turnNumber = (turnId: string) =>
  Object.values(FIXTURE_TURNS).find((t) => t.id === turnId)?.number;

/** A Turn or Turns selector's first and last Turn numbers, as the Daemon resolves them. */
const turnRange = (selector: TraceCompareSelector): Result<readonly [number, number]> | null => {
  const ends = Match.valueTags(selector, {
    Turn: ({ turnId }) => [turnId, turnId] as const,
    Turns: ({ firstTurnId, lastTurnId }) => [firstTurnId, lastTurnId] as const,
    Baseline: () => null,
    Trace: () => null,
  });

  if (ends === null) return null;
  const [first, last] = ends;
  const from = turnNumber(first);
  const to = turnNumber(last);

  if (from === undefined) return notFound(first);

  if (to === undefined) return notFound(last);

  return to < from
    ? fail("E-INPUT", "The turn range ends before it starts.", "Send the first turn first")
    : { ok: true, value: [from, to] };
};

const inTurns = (scene: TracesScene, from: number, to: number) =>
  details(scene)
    .map((d) => d.summary)
    .filter((t) => t.turn !== null && t.turn.number >= from && t.turn.number <= to);

/** A selector's traces: its Turns' attributed ones (an unknown Turn fails), or one trace. */
const selected = (
  scene: TracesScene,
  selector: TraceCompareSelector
): Result<ReadonlyArray<TraceSummary>> => {
  const range = turnRange(selector);

  if (range !== null) return range.ok ? { ok: true, value: inTurns(scene, ...range.value) } : range;

  if (!TraceCompareSelector.guards.Trace(selector)) return baselineMisplaced();
  const trace = findTrace(scene, selector.traceId);

  return trace.ok ? { ok: true, value: [trace.value.summary] } : trace;
};

const routeKey = (t: TraceSummary) => `${t.service}\u0000${t.root}`;

/** Baseline: attributed traces of the after side's routes from Turns before its first. */
const baselineFor = (
  scene: TracesScene,
  b: TraceCompareSelector,
  after: ReadonlyArray<TraceSummary>
): Result<ReadonlyArray<TraceSummary>> => {
  const range = turnRange(b);

  if (range === null) return baselineMisplaced();

  if (!range.ok) return range;
  const routes = new Set(after.map(routeKey));

  return {
    ok: true,
    value: inTurns(scene, 0, range.value[0] - 1).filter((t) => routes.has(routeKey(t))),
  };
};

const sideOf = (traces: ReadonlyArray<TraceSummary>, key: string) => {
  const route = traces.filter((t) => routeKey(t) === key);

  return { complete: route.filter((t) => !t.partial), partial: route.filter((t) => t.partial) };
};

/** What `traces.compare` would answer: every service and root on either side, sorted. */
export const fixtureComparison = (
  scene: TracesScene,
  a: TraceCompareSelector,
  b: TraceCompareSelector
): Result<TraceComparison> => {
  const after = selected(scene, b);

  if (!after.ok) return after;

  const before = TraceCompareSelector.guards.Baseline(a)
    ? baselineFor(scene, b, after.value)
    : selected(scene, a);

  if (!before.ok) return before;
  const keys = new Map([...before.value, ...after.value].map((t) => [routeKey(t), t]));

  const routes = [...keys.entries()]
    .map(([key, t]) => {
      const was = sideOf(before.value, key);
      const now = sideOf(after.value, key);
      const enough = was.complete.length >= MIN_RUNS && now.complete.length >= MIN_RUNS;
      const partial = { before: was.partial.length, after: now.partial.length };

      return {
        service: t.service,
        route: t.root,
        before: stats(was.complete, enough),
        after: stats(now.complete, enough),
        ...(partial.before + partial.after === 0 ? undefined : { partial }),
      };
    })
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
  span: (_at, traceId, spanId, before) => {
    const trace = findTrace(scene, traceId);

    if (!trace.ok) return Promise.resolve(trace);
    const span = trace.value.spans.find((s) => s.id.startsWith(spanId));

    if (span === undefined)
      return Promise.resolve(
        fail("E-TRACE-NOT-FOUND", `No span ${spanId} in trace ${traceId}`, "Open the trace again")
      );
    const logs = FIXTURE_LOGS.filter((l) => l.spanId === span.id).toReversed();
    const from = before === undefined ? 0 : logs.findIndex((l) => l.id === before.id) + 1;

    return Promise.resolve({
      ok: true,
      value: { span, logs: logs.slice(from, from + LOG_LIMIT), logCount: logs.length },
    });
  },
  compare: (_at, a, b) => Promise.resolve(fixtureComparison(scene, a, b)),
});
