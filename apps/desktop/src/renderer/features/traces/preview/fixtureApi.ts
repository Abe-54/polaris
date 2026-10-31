/**
 * A `TracesApi` over the fixtures, for `<TracesLayer api={fixtureTracesApi(scene)}>` in previews
 * and tests. Filters, ordering, limits and id prefixes follow the protocol's documented rules.
 */
import type { TraceDetail, TraceFilter, TraceSummary, TracesSnapshot } from "@polaris/protocol";
import type { Result } from "../../../../shared/api.ts";
import type { TracesApi } from "../data/api.ts";
import { FIXTURE_DETAILS, FIXTURE_LOGS, FIXTURE_SNAPSHOTS, type TracesScene } from "./fixtures.ts";

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

const details = (scene: TracesScene) => (scene === "traces" ? FIXTURE_DETAILS : []);

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
});
