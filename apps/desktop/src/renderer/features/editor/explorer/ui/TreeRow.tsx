/** One Files row (Paper E1): indent, chevron, name, agent slot, git slot. */
import { cn, DisclosureChevron } from "@polaris/ui";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import type { TreeRow as Row } from "../model/tree.ts";
import { AgentSlot, GitSlot, nameTone } from "./slots.tsx";

/** 6px, then 12px a level (Paper E1). */
export const indent = (depth: number) => 6 + depth * 12;

export interface TreeRowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly focused: boolean;
  readonly style: CSSProperties;
  readonly onActivate: (row: Row, pin: boolean) => void;
  readonly onFocusRow: (row: Row) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: Row) => void;
}

const Chevron = ({ row }: { readonly row: Row }) => (
  <span className="text-text-faint flex size-4 shrink-0 items-center justify-center">
    {row.kind === "folder" ? <DisclosureChevron open={row.open} size={16} /> : null}
  </span>
);

const caption = (row: Row) => {
  if (row.listing === "loading") return "Loading…";

  return row.listing === "error" ? "Couldn't list this folder" : null;
};

export const TreeRow = ({
  row,
  selected,
  focused,
  style,
  onActivate,
  onFocusRow,
  onKeyDown,
}: TreeRowProps) => {
  const note = caption(row);

  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.kind === "folder" ? row.open : undefined}
      aria-selected={selected}
      tabIndex={focused ? 0 : -1}
      data-path={row.path}
      data-testid="tree-row"
      data-kind={row.kind}
      style={{ ...style, paddingLeft: indent(row.depth) }}
      className={cn(
        "h-tree-row flex cursor-default items-center rounded-[8px] pr-2 outline-none select-none",
        "focus-visible:ring-starlight focus-visible:ring-2 focus-visible:ring-inset",
        selected ? "bg-fill-selected" : "hover:bg-fill-hover"
      )}
      onClick={(event: MouseEvent) => {
        onFocusRow(row);
        onActivate(row, event.detail >= 2);
      }}
      onContextMenu={() => onFocusRow(row)}
      onKeyDown={(event) => onKeyDown(event, row)}
    >
      <Chevron row={row} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2 pl-1">
        <span
          className={cn(
            "text-label font-regular truncate",
            nameTone(row.git, selected, row.kind === "folder"),
            row.deleted && "line-through"
          )}
          title={row.label}
        >
          {row.label}
        </span>
        {note === null ? null : (
          <span className="text-caption text-text-subtle truncate">{note}</span>
        )}
      </span>
      <AgentSlot agent={row.agent} hand={row.hand} />
      <GitSlot git={row.git} dirty={row.dirty} />
    </div>
  );
};
