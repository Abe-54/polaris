/**
 * A waterfall row (DESIGN.md, Traces → Waterfall; Paper T1): the tree gutter of 1px connectors, a
 * count badge on a parent (a tan ×n on a fold) or a square on a leaf, the name, the service where
 * it changes, the FAST/SLOW lane, and the bar in its service's hue with its duration after it.
 */
import type { TraceDetail } from "@polaris/protocol";
import { durationVerdict } from "../../model/usual.ts";
import { cn } from "@polaris/ui";
import { memo } from "react";
import { showBidi } from "../../../data/grid/value.ts";
import {
  durationLabel,
  ERROR_HUE,
  type SpanNode,
  type WaterfallRow,
} from "../../model/waterfall/index.ts";
import type { TimeWindow } from "./useTraceView.ts";

/** A level's indent; the root's marker is centred at `MARKER_AT` (Paper T1's 20px steps from 30). */
const INDENT = 20;

const MARKER_AT = 30;

const markerAt = (depth: number) => MARKER_AT + INDENT * depth;

/** Deeper levels share this one's indent, under a "+n", so names keep the column. */
const MAX_INDENT = 12;

/** The connectors, drawn in a 28-high box that stretches to the row's density height. */
const Gutter = ({ row }: { readonly row: WaterfallRow }) => {
  const { depth, guides, last, open } = row;
  const width = markerAt(depth) + 13;
  const parent = markerAt(depth - 1);

  return (
    <svg
      aria-hidden
      className="text-text-strong pointer-events-none absolute inset-y-0 left-0 h-full"
      width={width}
      viewBox={`0 0 ${width} 28`}
      preserveAspectRatio="none"
      stroke="currentColor"
      strokeOpacity={0.14}
      fill="none"
    >
      {guides.map((on, i) =>
        on ? (
          <path key={i} d={`M${markerAt(i) + 0.5} 0V28`} vectorEffect="non-scaling-stroke" />
        ) : null
      )}
      {depth > 0 ? (
        <path
          d={`M${parent + 0.5} 0V${last ? 14 : 28}M${parent + 0.5} 14H${markerAt(depth) - 5}`}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {open ? (
        <path d={`M${markerAt(depth) + 0.5} 21V28`} vectorEffect="non-scaling-stroke" />
      ) : null}
    </svg>
  );
};

/** On a listed fold's first call: "×214 · listed", which folds the calls back into one row. */
const Refold = ({ node, actions }: { readonly node: SpanNode; readonly actions: RowActions }) => {
  const { refold } = node;

  if (refold === null) return null;

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`Fold the ${refold.count} calls`}
      onClick={(event) => {
        event.stopPropagation();
        actions.onFold(refold.key);
      }}
      className="text-git-modified-text hover:bg-git-modified/12 shrink-0 cursor-default rounded-[4px] px-1 font-mono text-[10px] leading-4"
    >
      ×{refold.count} · listed
    </button>
  );
};

export interface RowActions {
  readonly onSelect: (row: WaterfallRow) => void;
  readonly onCollapse: (key: string) => void;
  readonly onFold: (key: string) => void;
}

const Marker = ({
  row,
  hue,
  collapsed,
  actions,
}: {
  readonly row: WaterfallRow;
  readonly hue: string;
  readonly collapsed: boolean;
  readonly actions: RowActions;
}) => {
  const { node } = row;

  if (node.fold)
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-label={`List each of the ${node.spans.length} calls`}
        onClick={(event) => {
          event.stopPropagation();
          actions.onFold(node.key);
        }}
        className="bg-git-modified/12 text-git-modified-text flex h-4 min-w-[26px] shrink-0 cursor-default items-center justify-center rounded-[4px] px-1 font-mono text-[10px] leading-3"
      >
        ×{node.spans.length}
      </button>
    );

  if (node.children.length > 0)
    return (
      <button
        type="button"
        tabIndex={-1}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Show" : "Hide"} the ${node.descendants} spans under it`}
        onClick={(event) => {
          event.stopPropagation();
          actions.onCollapse(node.key);
        }}
        className={cn(
          "bg-raised-control ring-hairline flex h-4 min-w-[26px] shrink-0 cursor-default items-center justify-center rounded-[4px] px-1 font-mono text-[10px] leading-3 ring-1 ring-inset",
          collapsed ? "text-text-strong" : "text-text-subtle"
        )}
      >
        {node.descendants}
      </button>
    );

  return (
    <span className="flex w-[26px] shrink-0 justify-center" aria-hidden>
      <span className="size-1.5 rounded-[1.5px]" style={{ background: hue }} />
    </span>
  );
};

const pct = (n: number) => `${(n * 100).toFixed(4)}%`;

/** The bar and its duration, placed on the window's scale; nothing when outside it. */
const Bar = ({
  row,
  hue,
  selected,
  range,
  dim,
}: {
  readonly row: WaterfallRow;
  readonly hue: string;
  readonly selected: boolean;
  readonly range: TimeWindow;
  readonly dim: boolean;
}) => {
  const { node } = row;
  const span = range.to - range.from;

  if (node.end < range.from || node.start > range.to) return null;
  const left = Math.max(0, (node.start - range.from) / span);
  const right = Math.min(1, (node.end - range.from) / span);

  return (
    <div className="absolute inset-y-0 right-14 left-0">
      <div
        className={cn(
          "absolute top-1/2 h-2.5 min-w-0.5 -translate-y-1/2 rounded-[2px]",
          dim && "opacity-25"
        )}
        style={{
          left: pct(left),
          width: pct(right - left),
          background: selected ? hue : `color-mix(in srgb, ${hue} 65%, transparent)`,
        }}
      />
      <span
        className={cn(
          "text-micro tabular absolute top-1/2 -translate-y-1/2 pl-1.5 font-mono whitespace-nowrap",
          selected ? "text-text-default" : "text-text-subtle"
        )}
        style={{ left: pct(right) }}
      >
        {durationLabel(node.duration)}
      </span>
    </div>
  );
};

export interface SpanRowProps {
  /** The row's element id, which the treegrid's aria-activedescendant names. */
  readonly id: string;
  readonly row: WaterfallRow;
  readonly usual?: TraceDetail["usual"];
  readonly hue: string;
  readonly selected: boolean;
  readonly collapsed: boolean;
  readonly range: TimeWindow;
  /** Another service is hovered in the Services chip. */
  readonly dim: boolean;
  readonly actions: RowActions;
}

export const SpanRow = memo(
  ({ id, row, usual, hue, selected, collapsed, range, dim, actions }: SpanRowProps) => {
    const { node } = row;
    const indent = Math.min(row.depth, MAX_INDENT);
    const drawn = indent === row.depth ? row : { ...row, depth: indent };
    const tone = node.error ? ERROR_HUE : hue;
    const span = node.spans[0]?.span;
    const baseline = span === undefined || node.fold ? undefined : usual?.[span.id];
    const verdict = durationVerdict(node.duration, baseline);

    return (
      <div
        id={id}
        role="row"
        aria-selected={selected}
        aria-level={row.depth + 1}
        data-testid="waterfall-row"
        data-span={node.spans[0]?.span.id}
        onClick={() => actions.onSelect(row)}
        className={cn(
          "h-tree-row grid cursor-default grid-cols-[minmax(200px,40%)_44px_minmax(0,1fr)] items-center",
          selected ? "bg-row-selected" : "hover:bg-fill-hover",
          row.context && "opacity-(--opacity-dimmed)"
        )}
      >
        <div
          role="gridcell"
          className="relative flex h-full min-w-0 items-center gap-[5px] overflow-clip pr-2"
          style={{ paddingLeft: markerAt(indent) - 13 }}
        >
          <Gutter row={drawn} />
          {indent < row.depth ? (
            <span
              className="text-micro text-text-faint absolute font-mono"
              style={{ left: markerAt(indent - 1) - 4 }}
              title={`${row.depth - indent} more levels deep`}
            >
              +{row.depth - indent}
            </span>
          ) : null}
          <Marker row={row} hue={tone} collapsed={collapsed} actions={actions} />
          <span
            className={cn(
              "text-code-inline relative min-w-0 truncate font-mono whitespace-nowrap",
              node.error && "text-severity-critical-text",
              !node.error && (selected ? "text-text-strong" : "text-text-default")
            )}
            title={node.name}
          >
            {showBidi(node.name)}
          </span>
          {node.error ? (
            <span
              className="text-micro text-severity-critical-text shrink-0"
              data-testid="row-error"
            >
              error
            </span>
          ) : null}
          <Refold node={node} actions={actions} />
          {node.newService ? (
            <span className="text-micro text-text-subtle shrink-0 font-mono">{node.service}</span>
          ) : null}
          {node.orphan ? (
            <span className="text-micro text-text-subtle shrink-0">parent not kept</span>
          ) : null}
        </div>
        <div role="gridcell" className="flex h-full items-center">
          {verdict === null ? null : (
            <span
              className="border-hairline text-text-subtle rounded-[3px] border px-1 font-mono text-[10px] leading-[14px]"
              title={`Usually ${durationLabel(baseline!.usualMs)} in this checkout (${baseline!.samples} samples)`}
              data-testid="duration-verdict"
            >
              {verdict}
            </span>
          )}
        </div>
        <div role="gridcell" className="relative h-full">
          <Bar row={row} hue={tone} selected={selected} range={range} dim={dim} />
        </div>
      </div>
    );
  }
);

SpanRow.displayName = "SpanRow";
