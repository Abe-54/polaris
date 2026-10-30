/**
 * One grid cell (DESIGN.md, Data: Table tab): mono, one clipped line, NULL faint, numbers
 * right-aligned tabular, a foreign key in the link colour with →. `staged` is phase 2's edit.
 */
import { cn } from "@polaris/ui";
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
  readonly onForeignKey?: ((column: LaidColumn, value: DataValue | undefined) => void) | undefined;
}

const BASE = "flex h-full shrink-0 items-center overflow-hidden px-2.5 whitespace-pre";

export const GridCell = memo(function GridCell({
  column,
  value,
  row,
  col,
  active,
  staged = false,
  onForeignKey,
}: GridCellProps) {
  const cell = cellOf(value);
  const text = displayOf(cell);
  const link = column.fk != null && cell.raw !== null && onForeignKey !== undefined;

  return (
    <div
      role="gridcell"
      aria-colindex={col + 2}
      aria-selected={active}
      data-row={row}
      data-col={col}
      data-kind={cell.kind}
      data-staged={staged || undefined}
      style={{ width: column.width }}
      className={cn(
        BASE,
        column.numeric && "tabular justify-end",
        cell.raw === null ? "text-text-faint" : "text-text-default",
        staged &&
          "bg-git-modified/12 text-git-modified-text ring-git-modified/40 ring-1 ring-inset",
        active && !staged && "ring-starlight ring-1 ring-inset"
      )}
    >
      {link ? (
        <button
          type="button"
          tabIndex={-1}
          data-testid="data-fk"
          title={`Open ${column.fk?.table ?? ""} where ${column.fk?.column ?? ""} = ${cell.raw ?? ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onForeignKey(column, value);
          }}
          className="text-starlight-text min-w-0 cursor-default truncate hover:underline"
        >
          {text} →
        </button>
      ) : (
        <span className="min-w-0 truncate">{text}</span>
      )}
    </div>
  );
});
