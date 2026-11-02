import type { Schema } from "effect";
import type { SpanErrorGroup, SpanErrors } from "../../traces/errors.ts";
import { STATS_SCAN_CAP } from "../../traces/stats.ts";
import { clipped, inline, TRACE_CAP } from "./traceFormat.ts";

interface ErrorsView {
  readonly text: string;
  readonly data: Schema.JsonObject;
}

const cell = (value: string) => clipped(inline(value), 300, "value", "trace_errors");

const counted = (values: SpanErrorGroup["services"]) =>
  values.map((item) => `${cell(item.value)} ×${item.count}`).join(", ");

const block = (group: SpanErrorGroup) =>
  [
    `×${group.count}  ${cell(group.fingerprint)}`,
    `  e.g. ${cell(group.message)}`,
    `  ${group.firstSeen} → ${group.lastSeen}  services ${counted(group.services)}`,
    `  spans ${counted(group.names)}${group.nameCount > group.names.length ? ` (+${group.nameCount - group.names.length} more)` : ""}`,
    `  newest trace ${group.example.trace} span ${group.example.span}`,
  ].join("\n");

/** One block per fingerprint, trimmed from the end to fit the shared 16,000-character cap. */
export const errorsView = (
  errors: SpanErrors,
  window: { readonly since: string; readonly minutes: number }
) => {
  const scope = `Error spans since ${window.since} (last ${window.minutes} min)`;

  if (errors.spans === 0)
    return {
      text: `${scope} · none. Widen sinceMinutes or loosen name or service.`,
      data: { fingerprints: [], groupCount: 0, spans: 0, truncated: false, since: window.since },
    } satisfies ErrorsView;

  const blocks = errors.fingerprints.map(block);
  let count = blocks.length;

  const capped = errors.truncated
    ? `\nScan capped at the newest ${STATS_SCAN_CAP} error spans, from ${errors.coveredSince}; narrow name, service or sinceMinutes for the whole window.`
    : "";

  const title = () =>
    `${scope} · ${errors.spans} spans in ${errors.groupCount} fingerprints${count < errors.groupCount ? ` (${count} shown; add limit or narrow filters)` : ""}${capped}`;

  while (count > 0 && [title(), ...blocks.slice(0, count)].join("\n").length > TRACE_CAP) count--;

  return {
    text: [title(), ...blocks.slice(0, count)].join("\n"),
    data: {
      fingerprints: errors.fingerprints.slice(0, count).map((group) => ({
        ...group,
        services: group.services.map((item) => ({ ...item })),
        names: group.names.map((item) => ({ ...item })),
        example: { ...group.example },
      })),
      groupCount: errors.groupCount,
      spans: errors.spans,
      truncated: errors.truncated,
      since: window.since,
      ...(errors.coveredSince === null ? undefined : { coveredSince: errors.coveredSince }),
    },
  } satisfies ErrorsView;
};
