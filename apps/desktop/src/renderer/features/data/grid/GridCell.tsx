/**
 * One grid cell (DESIGN.md, Data: Table tab): mono, one clipped line, NULL and the empty string
 * faint and italic, numbers right-aligned tabular, a foreign key in the link colour with →.
 * `staged` is phase 2's edit.
 */
import { memo } from "react";
import type { LaidColumn } from "./columns.ts";
import {
  cellOf,
  displayOf,
  type DataValue,
  fitWidth,
  placeholderOf,
  unfollowable,
} from "./value.ts";

export interface GridCellProps {
  readonly column: LaidColumn;
  readonly value: DataValue | undefined;
  readonly col: number;
  readonly active: boolean;
  /** A staged edit (phase 2): the modified ground and inset ring (rule/git-is-a-letter). */
  readonly staged?: boolean;
  /** The row height, so one line centres without a wrapper. */
  readonly height: number;
}

const BASE =
  "h-full shrink-0 overflow-hidden px-2.5 text-ellipsis whitespace-pre [contain:size_layout_style] [unicode-bidi:isolate]";

/** Class names joined by hand: a cell renders thousands of times a second while scrolling. */
const classes = (column: LaidColumn, flags: CellFlags, active: boolean, staged: boolean) => {
  let name = BASE;

  // The grid is mono, so its figures are already tabular: no OpenType feature to shape.
  if (column.numeric) name += " text-right";

  if (flags.placeholder) name += " text-text-faint italic";
  else if (staged) name += " bg-git-modified/12 text-git-modified-text";
  else if (flags.link) name += " text-starlight-text cursor-pointer hover:underline";
  else name += " text-text-default";

  if (staged) name += " ring-1 ring-inset ring-git-modified/40";
  else if (active) name += " ring-1 ring-inset ring-starlight";

  return name;
};

/** What a screen reader says for a placeholder, so NULL and '' never sound like text. */
const SPOKEN = { null: "null", empty: "empty string" } as const;

interface CellFlags {
  readonly placeholder: boolean;
  readonly link: boolean;
}

/**
 * A cell is one element; its row carries `data-row`, which changes as rows scroll, so cells don't.
 * A foreign key's value carries `data-fk`; the grid follows it on click or ⌘↵.
 */
export const GridCell = memo(function GridCell({
  column,
  value,
  col,
  active,
  staged = false,
  height,
}: GridCellProps) {
  const cell = cellOf(value);
  const placeholder = placeholderOf(cell);
  const blocked = column.fk == null || placeholder === "null" ? null : unfollowable(value);
  const link = column.fk != null && placeholder !== "null" && blocked === null;
  // A link's " →" takes two glyphs of the width.
  const text = fitWidth(displayOf(cell, column), column.width - (link ? 15 : 0));

  return (
    <div
      role="gridcell"
      aria-colindex={col + 2}
      aria-selected={active}
      data-col={col}
      data-kind={cell.kind}
      data-staged={staged || undefined}
      data-fk={link || undefined}
      data-testid={link ? "data-fk" : undefined}
      aria-label={placeholder === null ? undefined : SPOKEN[placeholder]}
      title={blocked ?? undefined}
      style={{ width: column.width, lineHeight: `${height}px` }}
      className={classes(column, { placeholder: placeholder !== null, link }, active, staged)}
    >
      {link ? `${text} →` : text}
    </div>
  );
});
