/**
 * Output's Traces tab for the Turn shown (DESIGN.md, Traces → In Orchestrate): its failing traces
 * first, then the slowest with what the same route took before, the rest folded under a count.
 */
import type { Span, TraceDetail, TraceSummary } from "@polaris/protocol";
import {
  type CodeLocation,
  codeLocation,
  type ExceptionView,
  exceptionOf,
} from "../model/span/code.ts";

/** Traces at least this slow are listed; faster ones fold. */
export const SLOW_MS = 100;

/** At most this many are listed before the fold, however slow. */
export const LISTED = 5;

export interface TraceRow {
  readonly trace: TraceSummary;
  /** The same root's duration in the latest earlier run outside this Turn; null when none. */
  readonly was: number | null;
}

export interface TurnTraces {
  readonly total: number;
  readonly errors: number;
  readonly failing: ReadonlyArray<TraceSummary>;
  readonly listed: ReadonlyArray<TraceRow>;
  readonly folded: ReadonlyArray<TraceRow>;
}

const startOf = (t: TraceSummary) => BigInt(t.startTimeUnixNano);

const newestFirst = (a: TraceSummary, b: TraceSummary) => {
  const delta = startOf(b) - startOf(a);

  return delta === 0n ? 0 : delta < 0n ? -1 : 1;
};

/** The latest earlier trace of the same root and service that isn't in `inTurn`. */
const previous = (t: TraceSummary, all: ReadonlyArray<TraceSummary>, inTurn: Set<string>) =>
  all
    .filter(
      (p) =>
        !inTurn.has(p.id) && p.root === t.root && p.service === t.service && startOf(p) < startOf(t)
    )
    .toSorted(newestFirst)[0] ?? null;

/**
 * `all` is the session's traces (any Turn), `turnIds` the Turns Output shows. Failing traces
 * newest first; the rest slowest first, listing those over `SLOW_MS` up to `LISTED`.
 */
export const turnTraces = (
  all: ReadonlyArray<TraceSummary>,
  turnIds: ReadonlySet<string>
): TurnTraces => {
  const inTurn = all.filter((t) => t.turn !== null && turnIds.has(t.turn.id));
  const ids = new Set(inTurn.map((t) => t.id));
  const failing = inTurn.filter((t) => t.errors > 0).toSorted(newestFirst);

  const rest = inTurn
    .filter((t) => t.errors === 0)
    .toSorted((a, b) => b.durationMs - a.durationMs)
    .map((trace) => ({ trace, was: previous(trace, all, ids)?.durationMs ?? null }));

  const cut = Math.min(LISTED, rest.filter((r) => r.trace.durationMs >= SLOW_MS).length);

  return {
    total: inTurn.length,
    errors: failing.length,
    failing,
    listed: rest.slice(0, cut),
    folded: rest.slice(cut),
  };
};

/** The fold's line: "11 more under 100 ms" when all are fast, else "11 more". */
export const foldedLine = (folded: ReadonlyArray<TraceRow>) =>
  folded.every((r) => r.trace.durationMs < SLOW_MS)
    ? `${folded.length} more under ${SLOW_MS} ms`
    : `${folded.length} more`;

export interface TraceFailure {
  /** The first exception's type and message ("AssertionError: …"); the span's status otherwise. */
  readonly headline: string;
  /** The deepest error span, where the failure happened. */
  readonly origin: Span | null;
  /** The exception's first frame in the checkout, else the root's code location. */
  readonly location: CodeLocation | null;
}

const headlineOf = (span: Span, exception: ExceptionView | null) => {
  if (exception?.message != null)
    return exception.type === null ? exception.message : `${exception.type}: ${exception.message}`;

  return span.statusMessage === "" ? "Failed" : span.statusMessage;
};

/** The first error span with no error span under it, at any depth. */
const deepestError = (spans: ReadonlyArray<Span>) => {
  const parentOf = new Map(spans.map((s) => [s.id, s.parentId]));
  const above = new Set<string>();

  for (const failed of spans.filter((s) => s.status === "error"))
    // `above` stops the walk at an ancestor already marked, and at a missing parent.
    for (let id = parentOf.get(failed.id); id != null && !above.has(id); id = parentOf.get(id))
      above.add(id);

  return spans.find((s) => s.status === "error" && !above.has(s.id)) ?? null;
};

/** What a failing trace's card says: what failed, in which span, and where in the code. */
export const traceFailure = ({ spans }: TraceDetail): TraceFailure => {
  const raised = spans.find((s) => s.events.some((e) => e.name === "exception"));
  const event = raised?.events.find((e) => e.name === "exception");
  const checkout = spans[0]?.polaris.checkout ?? "";
  const exception = event === undefined ? null : exceptionOf(event, checkout);
  const origin = deepestError(spans);
  const blamed = raised ?? origin ?? spans[0];
  const frame = exception?.frames.find((f) => f.inProject);
  const root = spans.find((s) => s.parentId === null) ?? spans[0];

  return {
    headline: blamed === undefined ? "Failed" : headlineOf(blamed, exception),
    origin,
    location:
      frame?.location ?? (root === undefined ? null : codeLocation(root.attributes, checkout)),
  };
};
