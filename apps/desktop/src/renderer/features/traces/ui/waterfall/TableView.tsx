/**
 * Table (DESIGN.md, Traces → Waterfall; Paper T6): the same spans flat, sortable by service,
 * duration, self time, start and status, longest first; a fold stays one row with its tan count
 * and summed duration. Durations share one scale. Virtualised like the waterfall.
 */
import { cn } from "@polaris/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, memo, useEffect, useMemo, useRef } from "react";
import {
  durationLabel,
  ERROR_HUE,
  serviceHue,
  type SortKey,
  sortFor,
  type SpanNode,
} from "../../model/waterfall/index.ts";
import { movedTo, selectedIndex, useTreeRowHeight } from "./useRowKeys.ts";
import type { TraceView } from "./useTraceView.ts";

const COLUMNS = "grid grid-cols-[112px_minmax(120px,1fr)_196px_64px_72px_56px] items-center px-4";

const HEADS: ReadonlyArray<{
  readonly key: SortKey | null;
  readonly label: string;
  readonly end?: boolean;
}> = [
  { key: "service", label: "SERVICE" },
  { key: null, label: "SPAN" },
  { key: "duration", label: "DURATION" },
  { key: "self", label: "SELF", end: true },
  { key: "start", label: "START", end: true },
  { key: "status", label: "STATUS", end: true },
];

const Head = ({ trace }: { readonly trace: TraceView }) => (
  <div
    role="row"
    className={`${COLUMNS} border-hairline text-micro h-8 shrink-0 border-b font-mono font-medium tracking-[0.06em]`}
  >
    {HEADS.map((head) => {
      const active = head.key !== null && trace.sort.key === head.key;
      const arrow = active ? (trace.sort.descending ? " ↓" : " ↑") : "";

      return head.key === null ? (
        <span key={head.label} role="columnheader" className="text-text-subtle">
          {head.label}
        </span>
      ) : (
        <button
          key={head.label}
          type="button"
          role="columnheader"
          aria-sort={active ? (trace.sort.descending ? "descending" : "ascending") : "none"}
          data-testid={`table-sort-${head.key}`}
          onClick={() => {
            if (head.key !== null) trace.setSort(sortFor(trace.sort, head.key));
          }}
          className={cn(
            "hover:text-text-default cursor-default whitespace-nowrap outline-none focus-visible:underline",
            head.end === true && "text-right",
            active ? "text-text-default" : "text-text-subtle"
          )}
        >
          {head.label}
          {arrow}
        </button>
      );
    })}
  </div>
);

interface TableRowProps {
  readonly node: SpanNode;
  readonly hue: string;
  readonly longest: number;
  readonly selected: boolean;
  readonly dim: boolean;
  readonly onSelect: (node: SpanNode) => void;
  readonly onFold: (key: string) => void;
}

const TableRow = memo(({ node, hue, longest, selected, dim, onSelect, onFold }: TableRowProps) => {
  const tone = node.error ? ERROR_HUE : hue;

  return (
    <div
      role="row"
      aria-selected={selected}
      data-testid="table-row"
      data-span={node.spans[0]?.span.id}
      onClick={() => onSelect(node)}
      className={cn(
        COLUMNS,
        "h-tree-row text-micro border-hairline cursor-default border-b font-mono",
        selected ? "bg-row-selected" : "hover:bg-fill-hover"
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-[1.5px]" style={{ background: hue }} />
        <span className="text-text-subtle truncate">{node.service}</span>
      </span>
      <span className="flex min-w-0 items-center gap-2 pr-2">
        <span
          className={cn(
            "text-code-inline truncate",
            node.error && "text-severity-critical-text",
            !node.error && (selected ? "text-text-strong" : "text-text-default")
          )}
        >
          {node.name}
        </span>
        {node.fold ? (
          <button
            type="button"
            aria-label={`List each of the ${node.spans.length} calls`}
            onClick={(event) => {
              event.stopPropagation();
              onFold(node.key);
            }}
            className="bg-git-modified/12 text-git-modified-text shrink-0 cursor-default rounded-[4px] px-[5px] py-px text-[10px] leading-3"
          >
            ×{node.spans.length}
          </button>
        ) : null}
      </span>
      <span className="flex items-center gap-2">
        <span className="relative h-2.5 w-[124px] shrink-0">
          <span
            className={cn("absolute inset-y-0 left-0 min-w-0.5 rounded-[2px]", dim && "opacity-25")}
            style={{
              width: `${(node.duration / longest) * 100}%`,
              background: selected ? tone : `color-mix(in srgb, ${tone} 65%, transparent)`,
            }}
          />
        </span>
        <span className={cn("tabular", selected ? "text-text-default" : "text-text-subtle")}>
          {durationLabel(node.duration)}
        </span>
      </span>
      <span className="text-text-subtle tabular text-right">{durationLabel(node.self)}</span>
      <span className="text-text-subtle tabular text-right">+{durationLabel(node.start)}</span>
      <span
        className={cn(
          "text-right",
          node.error ? "text-severity-critical-text" : "text-text-subtle"
        )}
      >
        {node.error ? "ERROR" : "OK"}
      </span>
    </div>
  );
});

TableRow.displayName = "TableRow";

const Foot = ({ trace }: { readonly trace: TraceView }) => {
  const folds = trace.table.filter((n) => n.fold).length;
  const { spans } = trace.times.summary;

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 px-4" data-testid="table-foot">
      <span className="text-micro text-text-subtle font-mono">
        {spans.toLocaleString("en-US")} SPANS · {trace.table.length.toLocaleString("en-US")} ROWS
        {folds > 0 ? ` · ${folds} ${folds === 1 ? "REPEAT" : "REPEATS"} COLLAPSED` : ""}
      </span>
      <span className="flex-1" />
      {folds > 0 ? (
        <span className="text-caption text-text-subtle">
          ×n rows sum their calls; click the count to list each one
        </span>
      ) : null}
    </div>
  );
};

export const TableView = ({
  trace,
  spanId,
  onSelect,
}: {
  readonly trace: TraceView;
  readonly spanId: string | null;
  readonly onSelect: (spanId: string | null) => void;
}) => {
  const scroller = useRef<HTMLDivElement>(null);
  const height = useTreeRowHeight();
  const { table, times, hovered } = trace;
  const hues = useMemo(() => new Map(times.services.map((s) => [s.name, s.index])), [times]);

  const longest = useMemo(
    () => table.reduce((max, n) => Math.max(max, n.duration), 0.001),
    [table]
  );

  const at = selectedIndex(table, spanId);

  const virtualizer = useVirtualizer({
    count: table.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => height,
    getItemKey: (index) => table[index]?.key ?? index,
    overscan: 16,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, height]);

  const select = useMemo(
    () => (node: SpanNode) => onSelect(node.spans[0]?.span.id ?? null),
    [onSelect]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && spanId !== null) {
      event.stopPropagation();
      onSelect(null);

      return;
    }

    const next = movedTo(event, at, table.length);
    const node = next === null ? undefined : table[next];

    if (next === null || node === undefined) return;
    event.preventDefault();
    select(node);
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      role="grid"
      aria-label="Spans"
      data-testid="table"
    >
      <Head trace={trace} />
      <div
        ref={scroller}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="focus-visible:ring-starlight min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset"
      >
        {table.length === 0 ? (
          <p className="text-body text-text-subtle px-4 py-3">No spans match</p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const node = table[item.index];

              if (node === undefined) return null;

              return (
                <div
                  key={item.key}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <TableRow
                    node={node}
                    hue={serviceHue(hues.get(node.service))}
                    longest={longest}
                    selected={item.index === at}
                    dim={hovered !== null && hovered !== node.service}
                    onSelect={select}
                    onFold={trace.toggleFold}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <Foot trace={trace} />
    </div>
  );
};
