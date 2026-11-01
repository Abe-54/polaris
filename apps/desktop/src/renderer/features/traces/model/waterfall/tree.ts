/**
 * The waterfall's tree: each span a node under its parent, and repeated siblings (same name and
 * service, `FOLD_AT` or more) folded into one ×n node whose children are their merged children.
 */
import type { TimedSpan, TraceTimes } from "./trace.ts";

/** Siblings that repeat this many times fold into one row (DESIGN.md, Traces → Waterfall). */
export const FOLD_AT = 3;

export interface SpanNode {
  /** The span id, or the fold's key for a ×n node. */
  readonly key: string;
  /** One span, or every span a fold holds, in start order. */
  readonly spans: ReadonlyArray<TimedSpan>;
  /** True for a ×n node, which `expanded` can open into its spans. */
  readonly fold: boolean;
  /** On the first call of a fold that `expanded` lists, the fold to put back; else null. */
  readonly refold: { readonly key: string; readonly count: number } | null;
  readonly name: string;
  readonly service: string;
  /** Extent: the first start to the last end, in ms after the trace's start. */
  readonly start: number;
  readonly end: number;
  /** Summed over its spans: a fold's duration and self time are its calls' total. */
  readonly duration: number;
  readonly self: number;
  readonly error: boolean;
  /** No parent was retained for it, though it names one. */
  readonly orphan: boolean;
  /** Its service differs from its parent's (or it's a root), so the row names it. */
  readonly newService: boolean;
  readonly children: ReadonlyArray<SpanNode>;
  /** Spans under it, at any depth. */
  readonly descendants: number;
}

const groupKey = (s: TimedSpan) => `${s.span.service}\u0000${s.span.name}`;

const sum = (spans: ReadonlyArray<TimedSpan>, of: (s: TimedSpan) => number) =>
  spans.reduce((total, s) => total + of(s), 0);

interface Context {
  readonly times: TraceTimes;
  readonly expanded: ReadonlySet<string>;
}

const nodeOf = (
  ctx: Context,
  spans: ReadonlyArray<TimedSpan>,
  fold: string | null,
  parentService: string | null,
  refold: SpanNode["refold"] = null
): SpanNode => {
  const [first] = spans;

  if (first === undefined) throw new Error("A node needs a span");
  const key = fold ?? first.span.id;
  const kids = spans.flatMap((s) => ctx.times.children.get(s.span.id) ?? []);
  const children = nodesOf(ctx, kids, key, first.span.service);

  return {
    key,
    spans,
    fold: fold !== null,
    refold,
    name: first.span.name,
    service: first.span.service,
    start: first.start,
    end: spans.reduce((max, s) => Math.max(max, s.end), first.end),
    duration: sum(spans, (s) => s.span.durationMs),
    self: sum(spans, (s) => s.self),
    error: spans.some((s) => s.span.status === "error"),
    orphan: parentService === null && ctx.times.orphans.has(first.span.id),
    newService: parentService !== first.span.service,
    children,
    descendants: children.reduce((total, c) => total + c.spans.length + c.descendants, 0),
  };
};

/** Siblings in start order; a repeated group folds at its first member's place. */
const nodesOf = (
  ctx: Context,
  siblings: ReadonlyArray<TimedSpan>,
  parentKey: string,
  parentService: string | null
): ReadonlyArray<SpanNode> => {
  const groups = new Map<string, Array<TimedSpan>>();

  for (const s of siblings) {
    const list = groups.get(groupKey(s));

    if (list === undefined) groups.set(groupKey(s), [s]);
    else list.push(s);
  }

  const placed = new Set<string>();

  return siblings.flatMap((s) => {
    const group = groups.get(groupKey(s)) ?? [s];
    const fold = `${parentKey}/${groupKey(s)}`;

    if (group.length < FOLD_AT) return [nodeOf(ctx, [s], null, parentService)];

    if (ctx.expanded.has(fold)) {
      const first = group[0] === s ? { key: fold, count: group.length } : null;

      return [nodeOf(ctx, [s], null, parentService, first)];
    }

    if (placed.has(fold)) return [];
    placed.add(fold);

    return [nodeOf(ctx, group, fold, parentService)];
  });
};

/** The roots, with every repeat folded except those whose key is in `expanded`. */
export const spanTree = (
  times: TraceTimes,
  expanded: ReadonlySet<string> = new Set()
): ReadonlyArray<SpanNode> =>
  nodesOf({ times, expanded }, times.children.get(null) ?? [], "", null);

/** The node holds the span, as itself or one of its fold's calls. */
export const holds = (node: SpanNode, spanId: string) =>
  node.spans.some((s) => s.span.id === spanId);
