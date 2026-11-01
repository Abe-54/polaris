/**
 * Table (DESIGN.md, Traces → Waterfall; Paper T6): the same nodes as the waterfall, flat, with no
 * collapsing, sorted by a column. A fold stays one row with its calls' summed duration.
 */
import type { SpanNode } from "./tree.ts";

export type SortKey = "duration" | "self" | "start" | "service" | "status";

export interface TableSort {
  readonly key: SortKey;
  readonly descending: boolean;
}

/** Longest first, as T6 opens. */
export const DEFAULT_SORT: TableSort = { key: "duration", descending: true };

/** Numbers start longest or latest first; names and status start A→Z, errors first. */
export const sortFor = (current: TableSort, key: SortKey): TableSort =>
  current.key === key
    ? { key, descending: !current.descending }
    : { key, descending: key === "duration" || key === "self" };

const flat = (roots: ReadonlyArray<SpanNode>): ReadonlyArray<SpanNode> => {
  const out: Array<SpanNode> = [];

  const walk = (nodes: ReadonlyArray<SpanNode>) => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };

  walk(roots);

  return out;
};

const text = (a: string, b: string) => a.localeCompare(b, "en");

const COMPARE: Readonly<Record<SortKey, (a: SpanNode, b: SpanNode) => number>> = {
  duration: (a, b) => a.duration - b.duration,
  self: (a, b) => a.self - b.self,
  start: (a, b) => a.start - b.start,
  service: (a, b) => text(a.service, b.service) || text(a.name, b.name),
  // Ascending puts errors first: they're what a status sort is for.
  status: (a, b) => Number(b.error) - Number(a.error),
};

/** Ties keep tree order, so equal rows don't shuffle when the sort flips. */
export const tableRows = (
  roots: ReadonlyArray<SpanNode>,
  sort: TableSort = DEFAULT_SORT
): ReadonlyArray<SpanNode> => {
  const compare = COMPARE[sort.key];
  const sign = sort.descending ? -1 : 1;

  return flat(roots)
    .map((node, order) => ({ node, order }))
    .sort((a, b) => sign * compare(a.node, b.node) || a.order - b.order)
    .map((r) => r.node);
};
