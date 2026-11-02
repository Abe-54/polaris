import type { Schema } from "effect";
import type { SpanStats, SpanStatsGroup } from "../../traces/stats.ts";
import { STATS_SCAN_CAP } from "../../traces/stats.ts";
import { clipped, duration, inline, TRACE_CAP } from "./traceFormat.ts";

interface StatsView {
  readonly text: string;
  readonly data: Schema.JsonObject;
}

const cell = (value: string) => clipped(inline(value), 200, "value", "trace_stats");

const row = (group: SpanStatsGroup, attribute: string | undefined) =>
  [
    ...(attribute === undefined ? [] : [cell(`${attribute}=${group.attribute ?? "(none)"}`)]),
    ...(group.name === undefined ? [] : [cell(group.name)]),
    ...(group.service === undefined ? [] : [cell(group.service)]),
    `×${group.count}`,
    ...(group.errors > 0 ? [`${group.errors} ERROR${group.errors === 1 ? "" : "S"}`] : []),
    `p50 ${duration(group.p50Ms)}`,
    `p95 ${duration(group.p95Ms)}`,
    `max ${duration(group.maxMs)}`,
    `latest ${group.latestStart}`,
    `${group.errors > 0 ? "error" : "slowest"} trace ${group.example.trace} span ${group.example.span}`,
  ].join("  ");

/** One line per group, trimmed from the end to fit the shared 16,000-character cap. */
export const statsView = (
  stats: SpanStats,
  window: {
    readonly since: string;
    readonly minutes: number;
    readonly attribute?: string | undefined;
  }
) => {
  const scope = `Spans since ${window.since} (last ${window.minutes} min)`;

  if (stats.spans === 0)
    return {
      text: `${scope} · none matched. Widen sinceMinutes or loosen name, service, status or attributes.`,
      data: { groups: [], groupCount: 0, spans: 0, truncated: false, since: window.since },
    } satisfies StatsView;

  const rows = stats.groups.map((group) => row(group, window.attribute));
  let count = rows.length;

  const capped = stats.truncated
    ? `\nScan capped at the newest ${STATS_SCAN_CAP} matching spans, from ${stats.coveredSince}; narrow name, service or sinceMinutes for the whole window.`
    : "";

  const title = () =>
    `${scope} · ${stats.spans} spans in ${stats.groupCount} groups${count < stats.groupCount ? ` (${count} shown; add limit or narrow filters)` : ""}${capped}`;

  while (count > 0 && [title(), ...rows.slice(0, count)].join("\n").length > TRACE_CAP) count--;

  return {
    text: [title(), ...rows.slice(0, count)].join("\n"),
    data: {
      groups: stats.groups
        .slice(0, count)
        .map((group) => ({ ...group, example: { ...group.example } })),
      groupCount: stats.groupCount,
      spans: stats.spans,
      truncated: stats.truncated,
      since: window.since,
      ...(stats.coveredSince === null ? undefined : { coveredSince: stats.coveredSince }),
    },
  } satisfies StatsView;
};
