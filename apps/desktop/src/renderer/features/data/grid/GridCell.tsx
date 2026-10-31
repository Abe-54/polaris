/**
 * One grid cell (DESIGN.md, Data: Table tab): mono, one clipped line, NULL faint, numbers
 * right-aligned tabular, a foreign key in the link colour with →. `staged` is phase 2's edit.
 */
import { memo } from "react";
import type { LaidColumn } from "./columns.ts";
import { cellOf, displayOf, type DataValue } from "./value.ts";

export interface GridCellProps {
  readonly column: LaidColumn;
  readonly value: DataValue | undefined;
  readonly row: number;
  readonly col: number;
  readonly active: boolean;
  /** A staged edit (phase 2): the modified ground and inset ring (rule/git-is-a-letter). */
  readonly staged?: boolean;
  /** The row height, so one line centres without a wrapper. */
  readonly height: number;
}

const BASE = "h-full shrink-0 overflow-hidden px-2.5 text-ellipsis whitespace-pre";

/** Class names joined by hand: a cell renders thousands of times a second while scrolling. */
const classes = (column: LaidColumn, kind: string, active: boolean, staged: boolean) => {
  let name = BASE;

  if (column.numeric) name += " tabular text-right";

  if (kind === "null") name += " text-text-faint";
  else if (staged) name += " bg-git-modified/12 text-git-modified-text";
  else if (column.fk != null) name += " text-starlight-text cursor-pointer hover:underline";
  else name += " text-text-default";

  if (staged) name += " ring-1 ring-inset ring-git-modified/40";
  else if (active) name += " ring-1 ring-inset ring-starlight";

  return name;
};

/**
 * A cell is one element. A foreign key's value carries `data-fk`; the grid follows it on click
 * or ⌘↵, so cells hold no handlers of their own.
 */
export const GridCell = memo(function GridCell({
  column,
  value,
  row,
  col,
  active,
  staged = false,
  height,
}: GridCellProps) {
  const cell = cellOf(value);
  const text = displayOf(cell, column);
  const link = column.fk != null && cell.raw !== null;

  return (
    <div
      role="gridcell"
      aria-colindex={col + 2}
      aria-selected={active}
      data-row={row}
      data-col={col}
      data-kind={cell.kind}
      data-staged={staged || undefined}
      data-fk={link || undefined}
      data-testid={link ? "data-fk" : undefined}
      style={{ width: column.width, lineHeight: `${height}px` }}
      className={classes(column, cell.kind, active, staged)}
    >
      {link ? `${text} →` : text}
    </div>
  );
});
