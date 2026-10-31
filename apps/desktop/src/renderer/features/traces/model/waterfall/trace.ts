/**
 * One trace's spans as the waterfall reads them: times in milliseconds after the trace's start,
 * children by parent in start order, self time, depth, and its services in order of appearance.
 */
import type { Span, TraceDetail, TraceSummary } from "@polaris/protocol";

export interface TimedSpan {
  readonly span: Span;
  /** Milliseconds after the trace's start. */
  readonly start: number;
  readonly end: number;
  /** Its duration less the time its children cover. */
  readonly self: number;
  readonly depth: number;
}

export interface ServiceStat {
  readonly name: string;
  /** Order of first appearance: the hue's index (DESIGN.md, Traces → Waterfall). */
  readonly index: number;
  readonly spans: number;
  /** Wall time while any of its spans ran. */
  readonly ms: number;
}

export interface TraceTimes {
  readonly summary: TraceSummary;
  readonly spans: ReadonlyArray<TimedSpan>;
  /** Children of a span id, in start order; roots under `null`. */
  readonly children: ReadonlyMap<string | null, ReadonlyArray<TimedSpan>>;
  /** Roots whose parent wasn't retained (a partial trace, or a parent upstream). */
  readonly orphans: ReadonlySet<string>;
  readonly startNs: bigint;
  /** The latest end, in milliseconds after the start. */
  readonly end: number;
  readonly levels: number;
  readonly services: ReadonlyArray<ServiceStat>;
}

const NS_PER_MS = 1_000_000;

/** Milliseconds from `origin` to `ns`, exact to the nanosecond before it becomes a number. */
const offset = (ns: string, origin: bigint) => Number(BigInt(ns) - origin) / NS_PER_MS;

/** Total length of the union of [start, end) intervals, sorted by start. */
export const coveredMs = (intervals: ReadonlyArray<readonly [number, number]>) => {
  const [first, ...rest] = intervals;

  if (first === undefined) return 0;
  let total = 0;
  let [from, to] = first;

  for (const [start, end] of rest) {
    if (start > to) {
      total += Math.max(0, to - from);
      from = start;
      to = end;
    } else to = Math.max(to, end);
  }

  return total + Math.max(0, to - from);
};

const byStart = (a: { start: number; span: Span }, b: { start: number; span: Span }) =>
  a.start - b.start || (a.span.id < b.span.id ? -1 : 1);

const selfTime = (
  start: number,
  end: number,
  kids: ReadonlyArray<{ start: number; end: number }>
) =>
  Math.max(
    0,
    end -
      start -
      coveredMs(kids.map((k) => [Math.max(k.start, start), Math.min(k.end, end)] as const))
  );

interface Draft {
  readonly span: Span;
  readonly start: number;
  readonly end: number;
}

/**
 * Each span's parent as drawn: null for a root, a parent that wasn't kept, or the first span
 * reached on a cycle (one naming itself counts), so bad data never hides a subtree.
 */
const parentsOf = (drafts: ReadonlyArray<Draft>) => {
  const ids = new Set(drafts.map((d) => d.span.id));

  const parent = new Map<string, string | null>(
    drafts.map((d) => [
      d.span.id,
      d.span.parentId !== null && ids.has(d.span.parentId) ? d.span.parentId : null,
    ])
  );

  const settled = new Set<string>();

  for (const d of drafts) {
    const walked = new Set<string>();
    let at: string | null = d.span.id;

    while (at !== null && !settled.has(at) && !walked.has(at)) {
      walked.add(at);
      at = parent.get(at) ?? null;
    }

    if (at !== null && walked.has(at)) parent.set(at, null);

    for (const id of walked) settled.add(id);
  }

  return parent;
};

const groupChildren = (
  drafts: ReadonlyArray<Draft>,
  parents: ReadonlyMap<string, string | null>
) => {
  const children = new Map<string | null, Array<Draft>>();

  for (const d of drafts) {
    const parent = parents.get(d.span.id) ?? null;
    const list = children.get(parent);

    if (list === undefined) children.set(parent, [d]);
    else list.push(d);
  }

  for (const list of children.values()) list.sort(byStart);

  return children;
};

/** Depth by walking down from the roots, so a cycle in bad data can't loop. */
const depths = (children: ReadonlyMap<string | null, ReadonlyArray<Draft>>) => {
  const depth = new Map<string, number>();
  const stack: Array<readonly [Draft, number]> = (children.get(null) ?? []).map((d) => [d, 0]);

  while (stack.length > 0) {
    const [d, level] = stack.pop() ?? [];

    if (d === undefined || level === undefined || depth.has(d.span.id)) continue;
    depth.set(d.span.id, level);

    for (const kid of children.get(d.span.id) ?? []) stack.push([kid, level + 1]);
  }

  return depth;
};

const serviceStats = (spans: ReadonlyArray<TimedSpan>): ReadonlyArray<ServiceStat> => {
  const seen = new Map<string, Array<readonly [number, number]>>();

  for (const s of spans) {
    const list = seen.get(s.span.service);

    if (list === undefined) seen.set(s.span.service, [[s.start, s.end]]);
    else list.push([s.start, s.end]);
  }

  return [...seen].map(([name, intervals], index) => ({
    name,
    index,
    spans: intervals.length,
    ms: coveredMs(intervals),
  }));
};

export const traceTimes = (detail: TraceDetail): TraceTimes => {
  const startNs = detail.spans.reduce((min, s) => {
    const ns = BigInt(s.startTimeUnixNano);

    return ns < min ? ns : min;
  }, BigInt(detail.summary.startTimeUnixNano));

  const drafts = detail.spans
    .map((span) => {
      const start = offset(span.startTimeUnixNano, startNs);

      return { span, start, end: Math.max(start, offset(span.endTimeUnixNano, startNs)) };
    })
    .sort(byStart);

  const parents = parentsOf(drafts);
  const grouped = groupChildren(drafts, parents);
  const depth = depths(grouped);

  const timed = new Map<string, TimedSpan>(
    drafts.map((d) => [
      d.span.id,
      {
        ...d,
        self: selfTime(d.start, d.end, grouped.get(d.span.id) ?? []),
        depth: depth.get(d.span.id) ?? 0,
      },
    ])
  );

  const spans = drafts.flatMap((d) => timed.get(d.span.id) ?? []);

  const children = new Map(
    [...grouped].map(([parent, list]) => [parent, list.flatMap((d) => timed.get(d.span.id) ?? [])])
  );

  const orphans = new Set(
    drafts
      .filter((d) => d.span.parentId !== null && parents.get(d.span.id) === null)
      .map((d) => d.span.id)
  );

  return {
    summary: detail.summary,
    spans,
    children,
    orphans,
    startNs,
    end: spans.reduce((max, s) => Math.max(max, s.end), 0),
    levels: spans.reduce((max, s) => Math.max(max, s.depth + 1), 0),
    services: serviceStats(spans),
  };
};
