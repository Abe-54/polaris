/**
 * What "Restart ‹service› with profiling" restarts (DESIGN.md, Traces → Sidebar): the trace's
 * root service and the `process.pid` its spans' resource names. The Daemon decides whether
 * Polaris started that process; the pid here is only a suggestion it revalidates.
 */
import type { Span, TraceDetail, TraceAttributes } from "@polaris/protocol";
import { Predicate } from "effect";

export interface RestartTarget {
  readonly service: string;
  readonly pid: number;
}

/** int64 attributes arrive as decimal strings (TraceAttributes). */
const pidOf = (resource: TraceAttributes): number | null => {
  const raw = resource["process.pid"];
  const n = Predicate.isString(raw) ? Number(raw) : raw;

  return Predicate.isNumber(n) && Number.isInteger(n) && n >= 1 ? n : null;
};

const targetOf = (span: Span): RestartTarget | null => {
  const pid = pidOf(span.resource);

  return pid === null ? null : { service: span.service, pid };
};

/** The root service's process when its spans carry a pid, else the first service's that do. */
export const restartTarget = (detail: TraceDetail | null): RestartTarget | null => {
  if (detail === null) return null;

  const root = detail.spans.find(
    (s) => s.service === detail.summary.service && pidOf(s.resource) !== null
  );

  const any = detail.spans.find((s) => pidOf(s.resource) !== null);
  const span = root ?? any;

  return span === undefined ? null : targetOf(span);
};
