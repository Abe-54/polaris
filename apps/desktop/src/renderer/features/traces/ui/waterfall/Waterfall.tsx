/**
 * The waterfall (DESIGN.md, Traces → Waterfall; Paper T1): the minimap, a ruler with the absolute
 * start and millisecond ticks (and the open Profile's overlap under them), the span rows (virtualised: a 10,000-span trace renders only what
 * shows), and "ENDED" with the span count and depth at the foot.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import {
  clockLabel,
  rulerTicks,
  serviceHue,
  type WaterfallRow,
} from "../../model/waterfall/index.ts";
import { Minimap } from "./Minimap.tsx";
import { type RowActions, SpanRow } from "./SpanRow.tsx";
import { movedTo, selectedIndex, useTreeRowHeight } from "./useRowKeys.ts";
import type { TimeWindow, TraceView } from "./useTraceView.ts";

const COLUMNS = "grid grid-cols-[minmax(200px,40%)_44px_minmax(0,1fr)]";

/** The open Profile's overlap as a line under the ticks, clipped to the shown range. */
const Mark = ({ mark, range }: { readonly mark: TimeWindow; readonly range: TimeWindow }) => {
  const span = range.to - range.from;
  const left = Math.max(0, (mark.from - range.from) / span);
  const right = Math.min(1, (mark.to - range.from) / span);

  if (right <= left) return null;

  return (
    <div
      data-testid="waterfall-profile-mark"
      className="bg-text-strong absolute bottom-[3px] h-0.5 min-w-0.5 rounded-[1px]"
      style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
    />
  );
};

const Ruler = ({
  trace,
  mark,
}: {
  readonly trace: TraceView;
  readonly mark: TimeWindow | null;
}) => {
  const { range, times } = trace;
  const span = range.to - range.from;
  const ticks = rulerTicks(range.from, range.to);
  const startNs = times.startNs + BigInt(Math.round(range.from * 1_000_000));

  return (
    <div
      className={`${COLUMNS} border-hairline text-micro h-7 shrink-0 items-center border-b font-mono`}
      data-testid="waterfall-ruler"
    >
      <div className="col-span-2 flex items-center gap-2 pl-4">
        <span className="text-text-subtle font-medium tracking-[0.06em]">START</span>
        <span className="text-text-subtle">{clockLabel(startNs)}</span>
      </div>
      <div className="relative h-full">
        <div className="absolute inset-y-0 right-14 left-0">
          {ticks.map((tick) => (
            <span
              key={tick.at}
              className="text-text-subtle absolute top-1/2 -translate-y-1/2 whitespace-nowrap"
              style={{ left: `${((tick.at - range.from) / span) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
          {mark === null ? null : <Mark mark={mark} range={range} />}
        </div>
      </div>
    </div>
  );
};

const Ended = ({ trace }: { readonly trace: TraceView }) => {
  const { times } = trace;
  const endNs = times.startNs + BigInt(Math.round(times.end * 1_000_000));
  const { spans, partial } = times.summary;

  return (
    <div
      className="border-hairline text-micro flex h-8 shrink-0 items-center gap-2 border-t pl-4 font-mono"
      data-testid="waterfall-ended"
    >
      <span className="text-text-subtle font-medium tracking-[0.06em]">ENDED</span>
      <span className="text-text-subtle">
        {clockLabel(endNs)} · {spans.toLocaleString("en-US")} {spans === 1 ? "span" : "spans"} ·{" "}
        {times.levels} {times.levels === 1 ? "level" : "levels"}
      </span>
      {partial ? (
        <span className="text-text-default" data-testid="waterfall-partial">
          · partial: retention removed some of its spans
        </span>
      ) : null}
    </div>
  );
};

export interface WaterfallProps {
  readonly trace: TraceView;
  /** The open Profile's overlap, in ms of the trace; marked under the ruler. */
  readonly mark?: TimeWindow | null;
  readonly spanId: string | null;
  readonly onSelect: (spanId: string | null) => void;
}

/** Left closes a node or goes to its parent; Right opens it (a fold lists its calls). */
const sideways = (
  event: KeyboardEvent,
  rows: ReadonlyArray<WaterfallRow>,
  at: number,
  trace: TraceView
): number | null => {
  const row = rows[at];

  if (row === undefined || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return null;
  const { node } = row;
  const closed = trace.collapsed.has(node.key);

  if (event.key === "ArrowRight") {
    if (node.fold) trace.toggleFold(node.key);
    else if (closed) trace.setCollapsed(node.key, false);

    return at;
  }

  if (row.open) {
    trace.setCollapsed(node.key, true);

    return at;
  }

  for (let i = at - 1; i >= 0; i--) if ((rows[i]?.depth ?? 0) < row.depth) return i;

  return at;
};

export const Waterfall = ({ trace, mark = null, spanId, onSelect }: WaterfallProps) => {
  const scroller = useRef<HTMLDivElement>(null);
  const height = useTreeRowHeight();
  const { rows, times, range, hovered, collapsed } = trace;
  const hues = useMemo(() => new Map(times.services.map((s) => [s.name, s.index])), [times]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => height,
    getItemKey: (index) => rows[index]?.node.key ?? index,
    overscan: 16,
  });

  // A density change resizes every row.
  useEffect(() => virtualizer.measure(), [virtualizer, height]);

  const actions: RowActions = useMemo(
    () => ({
      onSelect: (row) => onSelect(row.node.spans[0]?.span.id ?? null),
      onCollapse: trace.toggleCollapsed,
      onFold: trace.toggleFold,
    }),
    [onSelect, trace.toggleCollapsed, trace.toggleFold]
  );

  const nodes = useMemo(() => rows.map((r) => r.node), [rows]);
  const at = selectedIndex(nodes, spanId);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && spanId !== null) {
      event.stopPropagation();
      onSelect(null);

      return;
    }

    const next = movedTo(event, at, rows.length) ?? sideways(event, rows, at, trace);
    const row = next === null ? undefined : rows[next];

    if (next === null || row === undefined) return;
    event.preventDefault();
    onSelect(row.node.spans[0]?.span.id ?? null);
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="waterfall">
      <Minimap times={times} range={range} onRange={trace.setRange} />
      <Ruler trace={trace} mark={mark} />
      <div
        ref={scroller}
        role="treegrid"
        aria-label="Spans"
        aria-rowcount={rows.length}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="focus-visible:ring-starlight min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset"
        data-testid="waterfall-rows"
      >
        {rows.length === 0 ? (
          <p className="text-body text-text-subtle px-4 py-3">No spans match</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];

              if (row === undefined) return null;

              return (
                <div
                  key={item.key}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <SpanRow
                    row={row}
                    usual={trace.usual}
                    hue={serviceHue(hues.get(row.node.service))}
                    selected={item.index === at}
                    collapsed={collapsed.has(row.node.key)}
                    range={range}
                    dim={hovered !== null && hovered !== row.node.service}
                    actions={actions}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Ended trace={trace} />
    </div>
  );
};
