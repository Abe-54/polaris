/**
 * One open trace's view state: folds opened, nodes collapsed, the focus (Find spans, Errors only,
 * a service), the hovered service, the minimap's window and the Table's sort; and what follows.
 */
import type { TraceDetail } from "@polaris/protocol";
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import {
  DEFAULT_SORT,
  type Focus,
  focusOf,
  NO_FOCUS,
  parentKeys,
  spanTree,
  type TableSort,
  tableRows,
  traceTimes,
  waterfallRows,
} from "../../model/waterfall/index.ts";

/** The shown part of the trace, in ms after its start. */
export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

const toggled = (set: ReadonlySet<string>, key: string) => {
  const next = new Set(set);

  if (!next.delete(key)) next.add(key);

  return next;
};

export const useTraceView = (detail: TraceDetail) => {
  const times = useMemo(() => traceTimes(detail), [detail]);
  const full = useMemo(() => ({ from: 0, to: Math.max(times.end, 0.001) }), [times]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<Focus>(NO_FOCUS);
  const [hovered, setHovered] = useState<string | null>(null);
  // Null follows the whole trace, so a trace that grows while open stays in view.
  const [zoom, setZoom] = useState<TimeWindow | null>(null);
  const range = zoom ?? full;
  const [sort, setSort] = useState<TableSort>(DEFAULT_SORT);
  const shownFocus = useDeferredValue(focus);

  const roots = useMemo(() => spanTree(times, expanded), [times, expanded]);
  const parents = useMemo(() => parentKeys(roots), [roots]);
  const predicate = useMemo(() => focusOf(shownFocus), [shownFocus]);

  const rows = useMemo(
    () => waterfallRows(roots, { collapsed, focus: predicate }),
    [roots, collapsed, predicate]
  );

  const table = useMemo(() => {
    const all = tableRows(roots, sort);

    return predicate === null ? all : all.filter(predicate);
  }, [roots, sort, predicate]);

  const allCollapsed = parents.size > 0 && [...parents].every((k) => collapsed.has(k));

  return {
    times,
    usual: detail.usual,
    roots,
    rows,
    table,
    focus,
    setFocus,
    hovered,
    setHovered,
    range,
    setRange: setZoom,
    full,
    sort,
    setSort,
    collapsed,
    allCollapsed,
    toggleCollapsed: useCallback((key: string) => setCollapsed((c) => toggled(c, key)), []),
    setCollapsed: useCallback(
      (key: string, closed: boolean) =>
        setCollapsed((c) => (c.has(key) === closed ? c : toggled(c, key))),
      []
    ),
    // Collapsing all also folds every listed ×n again.
    toggleAll: useCallback(() => {
      if (!allCollapsed) setExpanded(new Set());
      setCollapsed(allCollapsed ? new Set() : parents);
    }, [allCollapsed, parents]),
    toggleFold: useCallback((key: string) => setExpanded((e) => toggled(e, key)), []),
  };
};

export type TraceView = ReturnType<typeof useTraceView>;
